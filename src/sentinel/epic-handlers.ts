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

import { evaluateLease, leasePatch, readLease, releasePatch } from '../shared/epic-lease'
import { acknowledgedCardIds, appendEpicLog, dispatchCountsByCard, readEpicLog, sliceEpicLog } from '../shared/epic-log'
import { nowIso } from '../shared/epic-paths'
import { patchEpicRun, readEpicRun, startEpicRun } from '../shared/epic-run-store'
import type { EpicOp, EpicOpKind, EpicResult, EpicRunSnapshot } from '../shared/protocol'
import { patchCardMeta, readCardMeta } from './epic-card-meta'
import { SEAT_HANDLERS } from './epic-seat-handlers'

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

const HANDLERS: Record<EpicOpKind, EpicOpHandler> = {
  // The three CARD-scoped ops. Spread in rather than written here: they share
  // none of the epic-scoped helpers below and they address a different file.
  ...(SEAT_HANDLERS as Record<'seat_get' | 'seat_claim' | 'seat_release', EpicOpHandler>),

  /**
   * Arm / resume / reconfigure. Carries the LEASE back for the same reason `get`
   * does: a start reply is now read as the run's status block, and a status
   * block that reports "lease: free (never run)" on a resume whose overseer is
   * mid-generation is worse than no lease line at all.
   */
  start(root, msg, nowMs) {
    const run = startEpicRun(root, { epicId: msg.epicId, project: msg.projectRoot, ...(msg.start ?? {}) }, nowMs)
    return { ok: true, run: { ...run }, currentLease: readLease(readCardMeta(root, msg.epicId) ?? {}) }
  },

  /**
   * The one pure read. Returns the lease as well as the run, because the lease
   * lives on the CARD -- so without it here the only way to answer "who is
   * holding this epic, and since when" was to open the card by hand, which
   * defeats the point of putting it somewhere visible.
   *
   * And it returns `acknowledgedCardIds` FOLDED OVER THE WHOLE LOG, beside the
   * prompt-sized tail. Two answers because there are two questions: an overseer
   * generation needs the last 20 entries to pick up cold, and the beat needs to
   * know which cards have ever been acknowledged. Answering the second with the
   * first is what froze epic-the-wall for five generations -- and the obvious
   * repair, widening the tail, would put a 3000-line log in every overseer
   * prompt. The file is read whole either way, so the fold is free.
   */
  get(root, msg) {
    const entries = readEpicLog(root, msg.epicId)
    return {
      ok: true,
      run: snapshot(root, msg.epicId),
      baton: sliceEpicLog(entries, { limit: BATON_TAIL, ...(msg.baton ?? {}) }),
      acknowledgedCardIds: acknowledgedCardIds(entries),
      // The third whole-log fold, beside the other two and for the same reason:
      // the file is read whole either way, and the beat's ceiling on redispatch
      // is a question about the entire run, not about its last 20 entries.
      dispatchCounts: dispatchCountsByCard(entries),
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

  /**
   * ACKNOWLEDGE A DEAD RUN -- the burial O2 never gave it.
   *
   * NOT A DELETE, and that is the whole design: `run.md` keeps every field, the
   * baton keeps every entry, the cards keep their history. All this writes is
   * "a human has seen this end", which is enough for the wall to stop showing
   * it. Deleting artifacts to tidy an ambient pane would trade a permanent
   * record for a transient one, and the record is what the engine is FOR.
   *
   * REFUSES A LIVE RUN, deliberately. `clear` is not a quieter `abort`: if it
   * silently stopped an armed run, the pane's tidy-up button would become the
   * most destructive control on the surface. Pause or abort first, then clear.
   */
  clear(root, msg, nowMs) {
    const current = readEpicRun(root, msg.epicId)
    if (!current) return fail(`epic run not found: ${msg.epicId}`)
    // The ARTIFACT'S OWN INTENT, not `runVitality`. Vitality folds in the armed
    // set, the beat ring and live seats -- broker-side facts the sentinel does
    // not have and should not learn. The artifact says what the run was told to
    // do, and refusing on that is the strictest of the two answers anyway: a run
    // marked armed is refused even if every seat under it is dead.
    if (current.status === 'armed' || current.status === 'running') {
      return fail(`run is ${current.status} -- pause or abort it before clearing`)
    }
    const run = patchEpicRun(root, msg.epicId, { acknowledgedAt: nowIso(nowMs) }, nowMs)
    if (!run) return fail(`epic run not found: ${msg.epicId}`)
    appendEpicLog(
      root,
      msg.epicId,
      { kind: 'checkpoint', convId: 'sentinel', body: `Run CLEARED from the wall (status ${current.status})` },
      nowMs,
    )
    return { ok: true, run: { ...run } }
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
