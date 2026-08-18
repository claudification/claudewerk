/**
 * THE EPIC EXECUTOR -- one beat, performed.
 *
 * `planBeat` decides; this sequences. The split is why the interesting cases are
 * testable without a sentinel: everything below is plumbing plus the one thing
 * plumbing can still get wrong, which is ORDER.
 *
 * Order is the whole contract here:
 *   1. read the run + baton + board,
 *   2. acknowledge every settled card into the baton BEFORE anything else,
 *   3. take the lease (CAS) and spawn the overseer, or
 *   4. dispatch/verify, or park/complete.
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
import { type EpicBeat, planBeat } from './epic-beat'
import { acknowledge, performActions } from './epic-beat-actions'
import { recordBeat } from './epic-beat-log'
import { epicIo, tag } from './epic-io'
import { type EpicGroup, generationMismatch, unacknowledgedCards } from './epic-sweep'
import type { BeatDeps, BeatOutcome } from './epic-types'

export type { BeatDeps, BeatOutcome } from './epic-types'

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
 * Run ONE beat for one epic. Returns what it did, so the sweep can log a single
 * line per epic per tick rather than a scatter of unrelated messages.
 */
export async function runEpicBeat(deps: BeatDeps, group: EpicGroup): Promise<BeatOutcome> {
  const io = epicIo()
  const view = await io.fetchEpicRun(deps, group.project, group.epicId)
  if (!view.run) {
    return finish(deps, group, 0, {
      epicId: group.epicId,
      note: 'no run artifact -- the epic is armed but nothing is on disk for it',
      actions: 0,
      spawned: [],
      error: view.error,
    })
  }
  const run = view.run

  const mismatch = generationMismatch(group, run.gen)
  if (mismatch) deps.log(`${tag(group.epicId, run.gen)} ${mismatch}`)

  const pending = unacknowledgedCards(group.settled, view.baton)
  if (pending.length > 0) await acknowledge(deps, group, pending)

  const cards = await io.fetchBoardCards(deps, group.project)
  const plan = planEpic({ cards, epicId: group.epicId, concurrency: run.concurrency, inFlight: group.inFlight })

  const windowOpen = run.cadence === 'window' ? await deps.windowOpen(group.project) : true
  const beat: EpicBeat = planBeat({
    run,
    plan,
    inFlight: group.inFlight,
    overseerAlive: group.overseerAlive,
    // Passed ON PURPOSE even though `acknowledge` just wrote them: a settle is
    // exactly what the overseer needs to be woken FOR. The baton write above is
    // what stops the NEXT sweep re-discovering the same settle forever.
    unacknowledged: pending,
    windowOpen,
    // Computed from the SAME card read the plan came from, so the fingerprint
    // and the plan can never describe two different boards.
    boardFingerprint: boardFingerprint(cards, group.epicId),
  })

  const spawned = await performActions(deps, group, run, beat, {
    batonTail: renderEpicLogTail(view.baton),
    plan,
    settled: pending,
    cardLines: plan.rollup?.children.map(c => `${c.card.slug} -- ${c.card.title} (${c.card.status})`) ?? [],
    epicBody: plan.rollup?.card?.bodyPreview ?? '',
  })

  return finish(deps, group, run.gen, {
    epicId: group.epicId,
    note: `${beat.note} (${beat.actions.length} action(s), ${spawned.length} spawned)`,
    actions: beat.actions.length,
    spawned,
  })
}
