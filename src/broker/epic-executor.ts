/**
 * THE EPIC EXECUTOR -- one beat, performed.
 *
 * `planBeat` decides; this sequences. The split is why the interesting cases are
 * testable without a sentinel: everything below is plumbing plus the one thing
 * plumbing can still get wrong, which is ORDER.
 *
 * Order is the whole contract here:
 *   1. read the run + baton + board,
 *   2. acknowledge every settled card into the baton BEFORE anything else, and
 *      record its `closes:` in the same pass,
 *   3. if this beat is going to park or complete, take the promise ledger's LAST
 *      CALL -- there is no beat after an inert run,
 *   4. take the lease (CAS) and spawn the overseer, or
 *   5. dispatch/verify, or park/complete.
 *
 * Step 2 comes first because a settle that is not written down is a settle the
 * next sweep re-discovers forever: `unacknowledgedCards` would keep returning
 * it, the beat would keep waking an overseer, and the generation counter would
 * climb with nothing moving. Acknowledge, THEN act.
 *
 * The four things a beat can DO live in `epic-beat-actions.ts`, and every side
 * effect goes through the `epic-io.ts` seam.
 */

import { boardFingerprint } from '../shared/epic-board-fingerprint'
import { renderEpicLogTail } from '../shared/epic-log'
import { planEpic } from '../shared/epic-ready'
import { gatedBy } from '../shared/epic-when'
import { type EpicBeat, type EpicBeatPatch, isInertRun, planBeat } from './epic-beat'
import { acknowledge, noteFailedLaunches, performActions } from './epic-beat-actions'
import { recordBeat } from './epic-beat-log'
import {
  applyCardRenames,
  cardRenames,
  orphanedAckLine,
  orphanedCardIds,
  renameAwareAcks,
  renameAwareCounts,
} from './epic-card-rename'
import type { EpicRunView } from './epic-broker-rpc'
import { epicIo, tag } from './epic-io'
import { recordFinalPromises, recordSettledPromises } from './epic-promise'
import type { QueueVerdict } from './epic-queue'
import { type EpicGroup, generationMismatch, unacknowledgedCards, unacknowledgedFailedLegs } from './epic-sweep'
import type { BeatDeps, BeatOutcome } from './epic-types'

export type { BeatDeps, BeatOutcome } from './epic-types'

/**
 * WHAT THE CALLER ALREADY KNOWS, so the beat does not ask again.
 *
 * Both fields exist for the same reason: the queue gate is a question about the
 * WHOLE project (`epic-queue.ts`), so somebody above one epic's beat has to have
 * read every run in the project before any of them beats. That reader is the
 * scanner, and handing its reads down here is what keeps the round-trip count
 * exactly where it was -- one `get` per epic per tick, not two.
 *
 * BOTH OPTIONAL, and absent means today's behaviour: fetch my own run, no queue
 * gate. Every test that drives one beat by hand keeps working unchanged, and a
 * future caller that forgets the pre-pass under-gates rather than mis-gates.
 */
export interface BeatContext {
  view?: EpicRunView
  queue?: QueueVerdict
}

/**
 * Every exit from a beat goes through here: log the line, ring the beat log,
 * return the outcome.
 *
 * A single funnel because the beat's most useful line used to be the one that
 * did not exist -- the early return below logged NOTHING, so "armed, but nothing
 * on disk" (the commonest failure) was indistinguishable from a healthy idle
 * sweep in `docker logs`. A return that skips the record is the bug this shape
 * makes hard to write.
 */
function finish(deps: BeatDeps, group: EpicGroup, gen: number, outcome: BeatOutcome): BeatOutcome {
  deps.log(`${tag(group.epicId, gen)} beat: ${outcome.note}${outcome.error ? ` -- ERROR ${outcome.error}` : ''}`)
  recordBeat(group.project, group.epicId, gen, outcome, deps.now())
  return outcome
}

/**
 * THE BEAT'S WRITES, APPLIED BEFORE ITS ACTIONS.
 *
 * BEFORE, not after: a beat that crashes mid-dispatch must still have recorded
 * what this generation was and what it spent, or the brake resets itself exactly
 * when the thing it exists to stop is going wrong.
 *
 * ONE op for the whole bag, and the bag is already pruned to what actually
 * changed (`planBeat`). The shape matters more than the two counters currently
 * in it: this is where every future per-beat fact gets persisted, and the
 * alternative -- a fresh `if (beat.x !== run.x) sendEpicOp(...)` block per
 * counter -- is how you end up with four round trips a beat and one of them
 * silently unreachable.
 */
async function applyBeatPatch(deps: BeatDeps, group: EpicGroup, gen: number, patch?: EpicBeatPatch): Promise<void> {
  if (!patch) return
  const res = await epicIo().sendEpicOp(deps, group.project, { op: 'patch', epicId: group.epicId, patch })
  if (!res.ok) {
    deps.log(`${tag(group.epicId, gen)} run patch FAILED (${Object.keys(patch).join(', ')}): ${res.error}`)
  }
}

/**
 * Run ONE beat for one epic. Returns what it did, so the sweep can log a single
 * line per epic per tick rather than a scatter of unrelated messages.
 */
export async function runEpicBeat(deps: BeatDeps, seats: EpicGroup, ctx: BeatContext = {}): Promise<BeatOutcome> {
  const io = epicIo()
  const view = ctx.view ?? (await io.fetchEpicRun(deps, seats.project, seats.epicId))
  if (!view.run) {
    return finish(deps, seats, 0, {
      epicId: seats.epicId,
      note: 'no run artifact -- the epic is armed but nothing is on disk for it',
      actions: 0,
      spawned: [],
      error: view.error,
    })
  }
  const run = view.run

  /**
   * A TERMINAL RUN IS TOUCHED BY NOTHING -- checked HERE, before the first write.
   *
   * `guardBeat` has always refused to ACT on a paused run, but it is consulted
   * after the acknowledgement pass below, and acknowledgement is a write. So a
   * paused epic that still had conversations in the registry kept appending
   * `completion` entries to its baton every 45 seconds, forever: on 2026-08-20
   * `epic-the-wall` had been paused for hours and its three newest log entries
   * were twenty seconds old. The pane was accused of lying about the age. The age
   * was true; the writes should never have happened.
   *
   * The board read below is skipped with it -- a run nobody may act on does not
   * need a sentinel round trip per tick either.
   */
  if (isInertRun(run.status)) {
    return finish(deps, seats, run.gen, {
      epicId: seats.epicId,
      note: `run is ${run.status}; not touched`,
      actions: 0,
      spawned: [],
    })
  }

  const mismatch = generationMismatch(seats, run.gen)
  if (mismatch) deps.log(`${tag(seats.epicId, run.gen)} ${mismatch}`)

  // THE BOARD IS READ FIRST, ahead of the acknowledgement it used to follow.
  // Nothing about the write order changes -- this is a read -- but every card id
  // below now has to be the id the BOARD uses, and only the board knows which
  // ids have been renamed. A seat's `cardId` is frozen at spawn (epic-spawn-plan)
  // and a rename leaves it answering to a name nobody asks about: on 2026-08-20
  // that put a second implementer onto a card whose first was still typing.
  const cards = await io.fetchBoardCards(deps, seats.project)
  const renames = cardRenames(cards)
  const group = applyCardRenames(seats, renames)

  // A live seat whose card is on no board is what a rename with no
  // `renamed_from:` looks like from here. Saying nothing is what cost that run a
  // seat, so it is a WARN -- the beat still proceeds, because the alternative is
  // freezing an epic over a card someone deleted.
  const orphans = orphanedCardIds(group, cards)
  if (orphans.length > 0) deps.log(`${tag(group.epicId, run.gen)} ${orphanedAckLine(orphans)}`)

  // Against the WHOLE log's acknowledgement set, never against `view.baton` --
  // that is a 20-entry prompt tail, and asking it this question is what made the
  // failure in this file's docstring real (gens 23-28, 2026-08-19). Rename-aware,
  // or a card acknowledged under its old id would settle again under its new one.
  const pending = unacknowledgedCards(group.settled, renameAwareAcks(view.acknowledgedCardIds, renames))
  if (pending.length > 0) await acknowledge(deps, group, pending)

  // THE PROMISE LEDGER, in the same region and for the same reason: a fact the
  // engine learned and did not write down is a fact the next sweep rediscovers
  // forever. A settled card gets the sha that delivered it written into its
  // `closes:` -- by the executor, never by the seat that did the work, which is
  // the whole point of the ledger. Its own standing question rather than a rider
  // on `pending`, because `pending` is the not-yet-acknowledged subset and a
  // promise that failed to resolve has to be askable again. Lane-agnostic; the
  // second and final chance is at LAST CALL below. Never blocks, never throws.
  await recordSettledPromises(deps, group, cards)

  // BEFORE the plan is computed, for `acknowledge`'s reason: a fact the baton
  // never records is a fact the next sweep rediscovers forever. A failed launch
  // does NOT wake the overseer, though -- the card simply stays dispatchable,
  // and the beat below will re-dispatch or re-verify it from board state. That
  // is the whole saving: one retry instead of a generation.
  const failed = unacknowledgedFailedLegs(group.failedLegs, view.baton)
  if (failed.length > 0) {
    deps.log(
      `${tag(group.epicId, run.gen)} ${failed.length} failed launch(es): ` +
        failed.map(l => `${l.cardId}/${l.role}@${l.convId.slice(0, 8)}`).join(', '),
    )
    await noteFailedLaunches(deps, group, failed)
  }

  const plan = planEpic({
    cards,
    epicId: group.epicId,
    concurrency: run.concurrency,
    inFlight: group.inFlight,
    inVerify: group.inVerify,
    unspawnable: group.unspawnable,
    // THE CEILING ON THE BOUNCE LANE, from the SAME `get` the run and the baton
    // came from. Rename-aware for `renameAwareAcks`'s reason: the log names a
    // card by whatever id it had when the seat went out, so a renamed card would
    // otherwise start its seat count over at zero.
    dispatches: renameAwareCounts(view.dispatchCounts, renames),
  })

  // ONE ROUND TRIP PER GATE THAT IS ACTUALLY CARRIED: a run whose `when` axis
  // never mentions the window must not pay a sentinel call to be told it does
  // not care. The queue gate costs nothing here -- the caller computed it across
  // the whole project before any epic beat started.
  const windowOpen = gatedBy(run.cadence, 'window') ? await deps.windowOpen(group.project) : true
  const beat: EpicBeat = planBeat({
    run,
    plan,
    inFlight: group.inFlight,
    overseerAlive: group.overseerAlive,
    ...(ctx.queue ? { queue: ctx.queue } : {}),
    // Passed ON PURPOSE even though `acknowledge` just wrote them: a settle is
    // exactly what the overseer needs to be woken FOR. The baton write above is
    // what stops the NEXT sweep re-discovering the same settle forever.
    unacknowledged: pending,
    windowOpen,
    // Computed from the SAME card read the plan came from, so the fingerprint
    // and the plan can never describe two different boards.
    boardFingerprint: boardFingerprint(cards, group.epicId),
    // THE RUN'S SPEND, FOLDED FRESH. Every conversation this epic has ever had
    // in the registry, summed over `turns.cost_usd` -- the overseer's
    // generations included, and the seats that died included, because both were
    // billed. `planBeat` reconciles this against the figure already banked on
    // the run; it is a FLOOR on the truth, since turns are pruned and the
    // registry forgets, and it must never be allowed to lower the ledger.
    spentUsd: deps.epicSpendUsd(group.convIds),
    nowMs: deps.now(),
  })

  // LAST CALL FOR THE PROMISE LEDGER. `park` and `complete` both flip the run to
  // an inert status, and `runEpicBeat` returns at `isInertRun` above before it
  // reads a single card -- so a beat carrying either is the last time any card
  // under this epic is looked at, ever. The race that makes this necessary:
  // `planEpic` completes a run off card LANES alone, without waiting for the
  // conversations behind them, so the last child's verifier can still be alive
  // (card not settled, pass above skips it) on the very beat that ends the run.
  // Still BEFORE the actions -- `b766b75e`'s rule -- so the write happens while
  // there is still a beat to do it in.
  //
  // `plan-checkpoint` pauses the run too and is deliberately NOT here: it fires
  // on generation 0, before anything has been dispatched, so no card has a
  // `worktree-epic/<epic>/<card>` branch for the ledger to resolve and every
  // card would buy a refusal entry for nothing. A checkpoint is also resumed
  // rather than ended -- beats follow it. Park and complete do not.
  if (beat.actions.some(a => a.kind === 'park' || a.kind === 'complete')) {
    await recordFinalPromises(deps, group, plan.rollup?.children.map(c => c.card) ?? [])
  }

  await applyBeatPatch(deps, group, run.gen, beat.patch)

  const spawned = await performActions(deps, group, run, beat, {
    batonTail: renderEpicLogTail(view.baton),
    plan,
    settled: pending,
    cardLines: plan.rollup?.children.map(c => `${c.card.slug} -- ${c.card.title} (${c.card.status})`) ?? [],
    epicBody: plan.rollup?.card?.bodyPreview ?? '',
    // From the SAME read as the run, so the CAS can ask whether THIS holder is
    // alive rather than whether any overseer is.
    holder: view.lease,
  })

  return finish(deps, group, run.gen, {
    epicId: group.epicId,
    note: `${beat.note} (${beat.actions.length} action(s), ${spawned.length} spawned)`,
    actions: beat.actions.length,
    spawned,
  })
}
