/**
 * Sentinel handlers for the EPIC MODE substrate RPCs (docs/epic-mode.md).
 *
 * The sentinel is the SOLE writer of `.rclaude/project/epics/` and of the epic
 * card's lease keys, for the same reason it owns the quest tree: the broker
 * never touches a filesystem, and an epic run must survive with zero live agent
 * hosts. The artifact is the API.
 *
 * The one genuinely interesting op is `lease`. The CAS itself is pure
 * (epic-lease.ts) but it has to be evaluated and written WITHOUT an await
 * between the read and the write, or two wakes racing on the same beat would
 * both read gen 5 and both grant. Node's single-threaded synchronous fs is what
 * makes that safe here; if this ever moves off it, this is the code that breaks.
 *
 * Op dispatch is a strategy map (STRATEGY MAPS covenant), not a switch.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { evaluateLease, leasePatch, readLease, releasePatch } from '../shared/epic-lease'
import { appendEpicLog, readEpicLogSlice } from '../shared/epic-log'
import { nowIso } from '../shared/epic-paths'
import { patchEpicRun, readEpicRun, startEpicRun } from '../shared/epic-run-store'
import { parseFrontmatter, serializeFrontmatter } from '../shared/frontmatter'
import { cardPath } from '../shared/project-paths'
import type { EpicOp, EpicOpKind, EpicResult, EpicRunSnapshot } from '../shared/protocol'

type OpOutcome = Omit<EpicResult, 'type' | 'requestId' | 'op'>
type EpicOpHandler = (root: string, msg: EpicOp, nowMs: number) => OpOutcome

const fail = (error: string): OpOutcome => ({ ok: false, error })

/** How many baton entries a `get` returns when the caller does not say. Enough
 *  for an overseer to pick up cold, small enough that a forty-generation run
 *  still fits in a prompt. A DEBUGGING caller overrides it via `baton.limit`;
 *  the default is sized for the prompt, not for the human. */
const BATON_TAIL = 20

function snapshot(root: string, epicId: string): EpicRunSnapshot | null {
  const run = readEpicRun(root, epicId)
  return run ? { ...run } : null
}

/**
 * Read-modify-write of the epic CARD's frontmatter. The lease lives there rather
 * than in the run file so a human reading the board can see -- and break -- a
 * stuck overseer without knowing the engine's storage layout.
 */
function patchCardMeta(root: string, epicId: string, patch: Record<string, unknown>): boolean {
  const file = cardPath(root, epicId, false)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  const { meta, body } = parseFrontmatter(raw)
  writeFileSync(file, serializeFrontmatter({ ...meta, ...patch }, body), 'utf8')
  return true
}

function readCardMeta(root: string, epicId: string): Record<string, unknown> | null {
  try {
    return parseFrontmatter(readFileSync(cardPath(root, epicId, false), 'utf8')).meta
  } catch {
    return null
  }
}

const HANDLERS: Record<EpicOpKind, EpicOpHandler> = {
  start(root, msg, nowMs) {
    const run = startEpicRun(root, { epicId: msg.epicId, project: msg.projectRoot, ...(msg.start ?? {}) }, nowMs)
    return { ok: true, run: { ...run } }
  },

  /**
   * The one pure read. Returns the lease as well as the run, because the lease
   * lives on the CARD -- so without it here the only way to answer "who is
   * holding this epic, and since when" was to open the card by hand, which
   * defeats the point of putting it somewhere visible.
   */
  get(root, msg) {
    return {
      ok: true,
      run: snapshot(root, msg.epicId),
      baton: readEpicLogSlice(root, msg.epicId, { limit: BATON_TAIL, ...(msg.baton ?? {}) }),
      currentLease: readLease(readCardMeta(root, msg.epicId) ?? {}),
    }
  },

  patch(root, msg, nowMs) {
    const run = patchEpicRun(root, msg.epicId, msg.patch ?? {}, nowMs)
    return run ? { ok: true, run: { ...run } } : fail(`epic run not found: ${msg.epicId}`)
  },

  log_append(root, msg, nowMs) {
    if (!msg.logAppend?.kind) return fail('logAppend.kind required')
    return { ok: true, logEntry: appendEpicLog(root, msg.epicId, msg.logAppend, nowMs) }
  },

  lease(root, msg, nowMs) {
    const req = msg.lease
    if (!req?.convId) return fail('lease.convId required')
    const meta = readCardMeta(root, msg.epicId)
    if (!meta) return fail(`epic card not found: ${msg.epicId}`)

    // No await between this read and the write below -- that is the CAS.
    const decision = evaluateLease(readLease(meta), req, nowMs)
    if (!decision.grant) {
      const h = decision.holder
      return { ok: true, lease: { granted: false, convId: h.convId, gen: h.gen, at: h.at, reason: decision.reason } }
    }
    patchCardMeta(root, msg.epicId, leasePatch(decision.lease))
    patchEpicRun(root, msg.epicId, { gen: decision.lease.gen, status: 'running' }, nowMs)
    return { ok: true, lease: { granted: true, ...decision.lease } }
  },

  release(root, msg) {
    if (!patchCardMeta(root, msg.epicId, releasePatch())) return fail(`epic card not found: ${msg.epicId}`)
    return { ok: true, run: snapshot(root, msg.epicId) }
  },

  pause(root, msg, nowMs) {
    const run = patchEpicRun(root, msg.epicId, { status: 'paused' }, nowMs)
    patchCardMeta(root, msg.epicId, releasePatch())
    return run ? { ok: true, run: { ...run } } : fail(`epic run not found: ${msg.epicId}`)
  },

  abort(root, msg, nowMs) {
    const run = patchEpicRun(root, msg.epicId, { status: 'aborted' }, nowMs)
    if (!run) return fail(`epic run not found: ${msg.epicId}`)
    patchCardMeta(root, msg.epicId, releasePatch())
    appendEpicLog(
      root,
      msg.epicId,
      { kind: 'checkpoint', convId: 'sentinel', body: `Run ABORTED: ${msg.reason || 'no reason given'}` },
      nowMs,
    )
    return { ok: true, run: { ...run, abortReason: msg.reason || 'aborted', updated: nowIso(nowMs) } }
  },
}

/** One op envelope in, one result out. Unknown ops fail loudly, never silently. */
export function handleEpicOp(root: string, msg: EpicOp, nowMs: number): EpicResult {
  const handler = HANDLERS[msg.op]
  const outcome = handler ? runGuarded(handler, root, msg, nowMs) : fail(`unknown epic op: ${msg.op}`)
  return { type: 'epic_result', requestId: msg.requestId, op: msg.op, ...outcome }
}

/** A throwing handler becomes a failed result, never an unhandled rejection that
 *  leaves the caller waiting for a reply that will never come. */
function runGuarded(handler: EpicOpHandler, root: string, msg: EpicOp, nowMs: number): OpOutcome {
  try {
    return handler(root, msg, nowMs)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}
