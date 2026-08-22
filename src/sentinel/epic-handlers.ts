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

import { relative } from 'node:path'
import { type EpicLease, OVERSEER_KEY_PREFIX, readLease, releasePatch } from '../shared/epic-lease'
import { acknowledgedCardIds, appendEpicLog, dispatchCountsByCard, readEpicLog, sliceEpicLog } from '../shared/epic-log'
import { nowIso } from '../shared/epic-paths'
import { deleteEpicRun, type EpicRun, patchEpicRun, readEpicRun, startEpicRun } from '../shared/epic-run-store'
import type { EpicRunStatus } from '../shared/epic-run-types'
import type { EpicOp, EpicOpKind, EpicResult, EpicRunSnapshot } from '../shared/protocol'
import { casLeaseOnCard, patchCardMeta, readCardMeta } from './epic-card-meta'
import { SEAT_HANDLERS } from './epic-seat-handlers'

type OpOutcome = Omit<EpicResult, 'type' | 'requestId' | 'op'>
type EpicOpHandler = (root: string, msg: EpicOp, nowMs: number) => OpOutcome

const fail = (error: string): OpOutcome => ({ ok: false, error })

/** How many baton entries a `get` returns when the caller does not say. Enough
 *  for a werk-master to pick up cold, small enough that a forty-generation run
 *  still fits in a prompt. A DEBUGGING caller overrides it via `baton.limit`;
 *  the default is sized for the prompt, not for the human. */
const BATON_TAIL = 20

/**
 * The only states a run may be DELETED from.
 *
 * An ALLOWLIST, where `clear` refuses on a denylist -- and the asymmetry is the
 * point. An acknowledgement written to the wrong run is one click from being
 * undone; a delete moves the artifact, so a status this file has not been taught
 * about must refuse rather than default to relocating the record.
 */
const DELETABLE: readonly EpicRunStatus[] = ['paused', 'aborted', 'complete']

/**
 * THE ONE PLACE THE GENERATION IS PROJECTED, and the reason there is no second
 * copy of it anywhere.
 *
 * `run.md` does not carry `gen` (epic-run-types.ts). The epic CARD does, as
 * `overseer_gen`, because that is what `evaluateLease` compares -- so every run
 * that leaves this file gets the number read fresh off the card, on the way out,
 * and nothing writes it back. A hand-edit of `run.md` therefore cannot move it,
 * a stale `gen:` key left over from an older engine is inert, and the wake, the
 * ceiling, the prompt header and the CAS are reading the same byte by
 * construction.
 *
 * 0 when the card has never held a lease, which is the same answer the counter
 * gave when it lived in the artifact.
 */
function withLeaseGen(run: EpicRun, lease: EpicLease | null): EpicRunSnapshot {
  return { ...run, gen: lease?.gen ?? 0 }
}

/** The werk-master lease as the epic CARD has it -- the generation's only home, and
 *  the one fact about a run that is not in the run's own directory. */
function currentLease(root: string, epicId: string): EpicLease | null {
  return readLease(readCardMeta(root, epicId) ?? {})
}

function projected(root: string, epicId: string, run: EpicRun): EpicRunSnapshot {
  return withLeaseGen(run, currentLease(root, epicId))
}

function snapshot(root: string, epicId: string): EpicRunSnapshot | null {
  const run = readEpicRun(root, epicId)
  return run ? projected(root, epicId, run) : null
}

const HANDLERS: Record<EpicOpKind, EpicOpHandler> = {
  // The three CARD-scoped ops. Spread in rather than written here: they share
  // none of the epic-scoped helpers below and they address a different file.
  ...(SEAT_HANDLERS as Record<'seat_get' | 'seat_claim' | 'seat_release', EpicOpHandler>),

  /**
   * Arm / resume / reconfigure. Carries the LEASE back for the same reason `get`
   * does: a start reply is now read as the run's status block, and a status
   * block that reports "lease: free (never run)" on a resume whose werk-master is
   * mid-generation is worse than no lease line at all.
   */
  start(root, msg, nowMs) {
    const run = startEpicRun(root, { epicId: msg.epicId, project: msg.projectRoot, ...(msg.start ?? {}) }, nowMs)
    const lease = currentLease(root, msg.epicId)
    return { ok: true, run: withLeaseGen(run, lease), currentLease: lease }
  },

  /**
   * The one pure read. Returns the lease as well as the run, because the lease
   * lives on the CARD -- so without it here the only way to answer "who is
   * holding this epic, and since when" was to open the card by hand, which
   * defeats the point of putting it somewhere visible.
   *
   * And it returns `acknowledgedCardIds` FOLDED OVER THE WHOLE LOG, beside the
   * prompt-sized tail. Two answers because there are two questions: a werk-master
   * generation needs the last 20 entries to pick up cold, and the beat needs to
   * know which cards have ever been acknowledged. Answering the second with the
   * first is what froze epic-the-wall for five generations -- and the obvious
   * repair, widening the tail, would put a 3000-line log in every werk-master
   * prompt. The file is read whole either way, so the fold is free.
   */
  get(root, msg, nowMs) {
    const entries = readEpicLog(root, msg.epicId)
    return {
      ok: true,
      run: snapshot(root, msg.epicId),
      // THE CLOCK THAT STAMPS EVERY `_at` ON EVERY LEASE, said out loud. The
      // broker judges a lease's AGE and this is the only way it can do that on one
      // clock rather than two -- see `EpicResult.clockMs`.
      clockMs: nowMs,
      baton: sliceEpicLog(entries, { limit: BATON_TAIL, ...(msg.baton ?? {}) }),
      acknowledgedCardIds: acknowledgedCardIds(entries),
      // The third whole-log fold, beside the other two and for the same reason:
      // the file is read whole either way, and the beat's ceiling on redispatch
      // is a question about the entire run, not about its last 20 entries.
      dispatchCounts: dispatchCountsByCard(entries),
      currentLease: currentLease(root, msg.epicId),
    }
  },

  patch(root, msg, nowMs) {
    const run = patchEpicRun(root, msg.epicId, msg.patch ?? {}, nowMs)
    return run ? { ok: true, run: projected(root, msg.epicId, run) } : fail(`epic run not found: ${msg.epicId}`)
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

    // The CAS itself is `casLeaseOnCard` -- shared with the per-card seat lease,
    // because the read-evaluate-write is identical and only the keys differ.
    const lease = casLeaseOnCard(root, msg.epicId, OVERSEER_KEY_PREFIX, meta, req, nowMs)
    // The one thing that is NOT shared: a granted werk-master lease means the run
    // is RUNNING, and a seat lease has no run to move.
    //
    // IT DOES NOT WRITE THE GENERATION. `casLeaseOnCard` has just advanced
    // `overseer_gen` on the card, which is the only copy there is; mirroring it
    // here is what this card deleted. See `withLeaseGen` above.
    if (lease.granted) patchEpicRun(root, msg.epicId, { status: 'running' }, nowMs)
    return { ok: true, lease }
  },

  release(root, msg) {
    if (!patchCardMeta(root, msg.epicId, releasePatch())) return fail(`epic card not found: ${msg.epicId}`)
    return { ok: true, run: snapshot(root, msg.epicId) }
  },

  pause(root, msg, nowMs) {
    const run = patchEpicRun(root, msg.epicId, { status: 'paused' }, nowMs)
    if (!run) return fail(`epic run not found: ${msg.epicId}`)
    // The generation is read BEFORE the release, and it survives it:
    // `releasePatch` deliberately leaves `overseer_gen` standing, or the next
    // wake would reuse a number the baton already holds (epic-lease.ts).
    const paused = projected(root, msg.epicId, run)
    patchCardMeta(root, msg.epicId, releasePatch())
    return { ok: true, run: paused }
  },

  abort(root, msg, nowMs) {
    const run = patchEpicRun(root, msg.epicId, { status: 'aborted' }, nowMs)
    if (!run) return fail(`epic run not found: ${msg.epicId}`)
    const aborted = projected(root, msg.epicId, run)
    patchCardMeta(root, msg.epicId, releasePatch())
    appendEpicLog(
      root,
      msg.epicId,
      { kind: 'checkpoint', convId: 'sentinel', body: `Run ABORTED: ${msg.reason || 'no reason given'}` },
      nowMs,
    )
    return { ok: true, run: { ...aborted, abortReason: msg.reason || 'aborted', updated: nowIso(nowMs) } }
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
    return { ok: true, run: projected(root, msg.epicId, run) }
  },

  /**
   * REMOVE A RUN FROM THE RECORD -- and `delete` is a MOVE, never an `rm`.
   *
   * `clear` says "this happened and I have seen it". This says "this should not
   * be in the record at all": a run armed by mistake, a duplicate, a scratch run
   * nobody wants in the history. Those are genuinely different questions, which
   * is the only reason a second verb exists -- the 2026-08-20 decision that an
   * ACK beats a delete still holds for everything `clear` covers.
   *
   * REFUSES ON AN ALLOWLIST, one notch stricter than `clear`'s denylist, and it
   * asks THE ARTIFACT'S OWN INTENT for the same reason `clear` does: vitality
   * folds in the armed set, the beat ring and live seats, which are broker-side
   * facts the sentinel does not have and should not learn. The broker adds the
   * refusal only IT can make -- no live seat may be writing to a tree that is
   * about to move (`epic-actions.ts`).
   *
   * THE BATON ENTRY IS WRITTEN BEFORE THE MOVE, so it travels INTO the
   * tombstone. A delete recorded only in the broker's log would be a deletion
   * the recovered artifact could not explain.
   *
   * IT DOES NOT TOUCH THE EPIC'S CARDS, deliberately and loudly. Cards outlive
   * runs by design -- that is what let `epic-project-runner` adopt eight cards
   * that already existed -- so a run is a record of an ATTEMPT, not the work.
   */
  delete(root, msg, nowMs) {
    const current = readEpicRun(root, msg.epicId)
    if (!current) return fail(`epic run not found: ${msg.epicId}`)
    if (!DELETABLE.includes(current.status)) {
      return fail(`run is ${current.status} -- only a paused, aborted or complete run can be deleted`)
    }
    appendEpicLog(
      root,
      msg.epicId,
      {
        kind: 'checkpoint',
        convId: 'sentinel',
        body: `Run DELETED from the record (status ${current.status}): ${msg.reason || 'no reason given'}`,
      },
      nowMs,
    )
    const to = deleteEpicRun(root, msg.epicId, nowMs)
    if (!to) return fail(`epic run not found: ${msg.epicId}`)
    // RELATIVE to the project, never the absolute path. This string is rendered
    // in a panel and pasted into reports; the box's directory layout is not
    // something a wall row needs to publish to say where the tombstone is.
    return { ok: true, run: projected(root, msg.epicId, current), deletedTo: relative(root, to) }
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
