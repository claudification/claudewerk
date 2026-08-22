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
import { pendingSeatCards, withPendingSeats } from '../shared/epic-pending-seats'
import { planEpic } from '../shared/epic-ready'
import { gatedBy } from '../shared/epic-when'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { EpicRunSnapshot } from '../shared/protocol'
import { type EpicBeat, type EpicBeatInput, type EpicBeatPatch, isInertRun, planBeat } from './epic-beat'
import {
  type AcknowledgeContext,
  acknowledge,
  noteFailedLaunches,
  performActions,
  reapOverseers,
  rendersRunState,
} from './epic-beat-actions'
import { recordBeat } from './epic-beat-log'
import { type EpicRunView, normalizeWhen } from './epic-broker-rpc'
import {
  applyCardRenames,
  cardRenames,
  orphanedAckLine,
  orphanedCardIds,
  renameAwareAcks,
  renameAwareCounts,
} from './epic-card-rename'
import type { HeadroomVerdict } from './epic-headroom'
import { epicIo, tag } from './epic-io'
import { recordFinalPromises, recordSettledPromises } from './epic-promise'
import type { QueueVerdict } from './epic-queue'
import { isArmed } from './epic-registry'
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
  /**
   * PLAN HEADROOM ACROSS THE FLEET, computed once per sweep rather than per epic.
   *
   * The reading is a property of the SENTINELS, not of any one epic, so every
   * group in a pass shares it -- the same argument that put the queue verdict in
   * the pre-pass. Absent means no gate.
   */
  headroom?: HeadroomVerdict
  /**
   * A HUMAN ASKED FOR THIS BEAT BY HAND (`epic_run action=beat`).
   *
   * The one thing it changes is the APPOINTMENT gate -- see `EpicBeatInput.forced`
   * for why `window` and `queue` stay unoverridable. Absent means the sweep, so a
   * caller that forgets it under-fires rather than over-fires.
   */
  forced?: boolean
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
 *
 * IT RETURNS THE RUN AS IT NOW STANDS ON DISK, which is free: the sentinel's
 * `patch` handler re-reads the file, merges, writes, and answers with the
 * result. That reply is the only object in this beat that is provably
 * post-write, and `renderedRun` below is what it exists for. `null` means there
 * was nothing to write or the write failed -- never "the run is unchanged".
 */
async function applyBeatPatch(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  patch?: EpicBeatPatch,
): Promise<EpicRunSnapshot | null> {
  if (!patch) return null
  const res = await epicIo().sendEpicOp(deps, group.project, { op: 'patch', epicId: group.epicId, patch })
  if (!res.ok) {
    deps.log(`${tag(group.epicId, gen)} run patch FAILED (${Object.keys(patch).join(', ')}): ${res.error}`)
    return null
  }
  // NORMALISED at this seam like every other sentinel reply: an older sentinel
  // answers with `cadence` as a bare string, and the prompt this run is about to
  // be rendered into calls `formatWhen` on it.
  return normalizeWhen(res.run ?? null)
}

/**
 * THE RUN THE SPAWNED PROMPTS ARE RENDERED FROM -- the copy on disk AFTER this
 * beat's own write, never the snapshot the beat decided from.
 *
 * THE ORDERING IS THE FIX, so do not tidy it back. `runEpicBeat` reads the run,
 * decides, writes the ledger, and only then spawns; handing the seats the object
 * it read at the top of that sequence renders every per-beat fact one beat
 * stale, always LOW, in the direction that cannot be recovered from. Live on
 * `epic-project-runner`, generations 3 through 11: the overseer's budget
 * sentence under-reported spend every single time, by one beat's dispatches
 * ($22.87 at gen 4, $14.11 at gen 11), while the file beside it was right.
 *
 * TWO SOURCES, ONE RULE -- "whatever the file says now":
 *   - this beat wrote something, so the patch reply IS the file (`applyBeatPatch`);
 *   - it wrote nothing, so the file may still have moved under it -- a human
 *     re-arming a run with a raised ceiling mid-beat is exactly the case, and
 *     the generation that re-arm wakes is the worst one to hand the old ceiling.
 *     That costs one extra read, bought only on the beats that spawn a seat
 *     carrying the run.
 *
 * The gate matters: every OTHER beat -- the idle sweep, a dispatch, a park --
 * renders no run at all, and paying a round trip per epic per 45 seconds to
 * refresh an object nobody reads is how a fix becomes a load on the sentinel.
 */
async function renderedRun(
  deps: BeatDeps,
  group: EpicGroup,
  beat: EpicBeat,
  decidedFrom: EpicRunSnapshot,
  written: EpicRunSnapshot | null,
): Promise<EpicRunSnapshot> {
  if (!rendersRunState(beat)) return decidedFrom
  if (written) return written
  const view = await epicIo().fetchEpicRun(deps, group.project, group.epicId)
  return view.run ?? decidedFrom
}

/**
 * WHAT A SETTLE NEEDS BEYOND THE CARD ID -- and the round trip it refuses to pay
 * unless a seat actually died.
 *
 * The git scan behind `gitDirt` is a sentinel round trip with a 15-second
 * ceiling, and the overwhelming majority of settles are ordinary completions that
 * have no use for it. So the trip is bought ONLY when this beat is about to
 * acknowledge a card whose seat was reaped: on a healthy run the cost is exactly
 * zero, and on the beat where it matters it buys the one fact nobody had on
 * 2026-08-21 -- that the corpse left 392 lines of finished work unstaged.
 *
 * Never throws and never blocks a settle. A scan that fails comes back as
 * UNKNOWN, which is reported as UNKNOWN; "we could not look" must not be allowed
 * to read as "there is nothing there".
 */
async function settleContext(
  deps: BeatDeps,
  group: EpicGroup,
  cards: readonly ProjectTaskMeta[],
  pending: readonly string[],
): Promise<AcknowledgeContext> {
  const lanes = new Map(cards.map(c => [c.slug, c.status]))
  const lane = (cardId: string) => lanes.get(cardId)
  const reaped = new Set(group.abandonedSeats.map(s => s.cardId))
  if (!pending.some(cardId => reaped.has(cardId))) return { lane }
  if (!deps.gitDirt) return { lane, dirt: null }
  try {
    return { lane, dirt: await deps.gitDirt(group.project) }
  } catch (err) {
    return { lane, dirt: { ok: false, error: err instanceof Error ? err.message : String(err) } }
  }
}

/**
 * THE GENERATION THIS BEAT IS AT, read once, OFF THE LEASE -- the number every
 * line of the beat quotes and every CAS it sends compares against.
 *
 * The run artifact does not carry one (`EpicRunMeta`): it used to mirror the
 * card's `overseer_gen`, nothing reconciled the two, and a drifted mirror is what
 * deadlocked `epic-the-wall-ii` for hours on 2026-08-20 -- `stale wake: expected
 * gen 12, epic is at gen 11`, every 45 seconds, spawning nothing, while every
 * panel surface said RUNNING. `view.lease` and `view.run` come from the SAME
 * `get`, so the ceiling, the log lines, the prompt header and the wake all name
 * one number by construction rather than by agreement.
 *
 * `null` lease means the epic has never been woken, which is generation 0 --
 * exactly what `evaluateLease` expects from a first wake.
 *
 * Its own function rather than an expression in `runEpicBeat` because that
 * function is already at its complexity ceiling and a `?.`/`??` pair costs two
 * branches there for a fact that is not a decision.
 */
function leaseGen(view: EpicRunView): number {
  return view.lease?.gen ?? 0
}

/**
 * WHEN THE GRIP WAS TAKEN, as a spread-ready fragment -- the TTL half of the
 * overseer gate (`overseerGate`, epic-beat.ts).
 *
 * Its own function for the identical reason {@link leaseGen} is, and the shape is
 * dictated by the same ceiling: `runEpicBeat` is at its complexity threshold, and
 * an inline `?.`/ternary pair for a fact that is not a decision costs it two
 * branches. Returning the FRAGMENT rather than the string keeps the ternary here
 * too -- the call site is one spread and no branch at all.
 *
 * EMPTY MEANS NO TTL, which is `EpicBeatInput.leaseAt`'s stated convention: an
 * epic that has never been woken has no grip to age out, and a beat must not
 * displace a supervisor on an age nobody supplied.
 */
function leaseTaken(view: EpicRunView): Pick<EpicBeatInput, 'leaseAt'> {
  return view.lease?.at ? { leaseAt: view.lease.at } : {}
}

/**
 * Run ONE beat for one epic. Returns what it did, so the sweep can log a single
 * line per epic per tick rather than a scatter of unrelated messages.
 */
export async function runEpicBeat(deps: BeatDeps, seats: EpicGroup, ctx: BeatContext = {}): Promise<BeatOutcome> {
  const io = epicIo()
  const view = ctx.view ?? (await io.fetchEpicRun(deps, seats.project, seats.epicId))
  if (!view.run) {
    // TWO WAYS TO HAVE NO RUN, ONE BEHAVIOUR, TWO SENTENCES. Skipping is right
    // for both, but the NOTE is what the wall row and the beat list render, and
    // "nothing is on disk for it" is a claim about a file a timed-out read never
    // reached. `view.error` is carried alongside either way.
    return finish(deps, seats, 0, {
      epicId: seats.epicId,
      note: view.error
        ? `run artifact NOT READ -- the read failed: ${view.error}; skipping this beat rather than acting blind`
        : 'no run artifact -- the epic is armed but nothing is on disk for it',
      actions: 0,
      spawned: [],
      error: view.error,
    })
  }
  const run = view.run
  const gen = leaseGen(view)

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
    return finish(deps, seats, gen, {
      epicId: seats.epicId,
      note: `run is ${run.status}; not touched`,
      actions: 0,
      spawned: [],
    })
  }

  // STRANDED -- said in the broker log, not only in the panel.
  //
  // The run artifact says this epic is live, and the sweep's armed set does not
  // carry it. That means the ONLY reason this beat is happening at all is a live
  // conversation, and the moment the last seat exits the epic falls out of both
  // halves of `epicsToWatch` and the run stops advancing with nothing logged and
  // nothing thrown. That is precisely how `epic-the-wall` died on 2026-08-19,
  // eleven minutes after a restart nobody connected to it.
  //
  // The armed set has been durable since 2026-08-21 (epic-registry.ts), so the
  // ways left in are narrow -- a run armed by a broker older than that fix, or a
  // project whose `epics` box was unticked while a run was live. Both need a
  // human, and `runVitality` could only tell one who went looking. Logged on
  // EVERY beat rather than once, because every one of them is inside the window
  // where a `start` still costs nothing.
  if (!isArmed(seats.project, seats.epicId)) {
    deps.log(
      `${tag(seats.epicId, gen)} STRANDED: the run is ${run.status} but this epic is not in the sweep's ` +
        `armed set -- it is visible only through its live conversations and stops advancing when the last one ` +
        `ends. Re-arm it with epic_run action=start.`,
    )
  }

  const mismatch = generationMismatch(seats, gen)
  if (mismatch) deps.log(`${tag(seats.epicId, gen)} ${mismatch}`)

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
  if (orphans.length > 0) deps.log(`${tag(group.epicId, gen)} ${orphanedAckLine(orphans)}`)

  // Against the WHOLE log's acknowledgement set, never against `view.baton` --
  // that is a 20-entry prompt tail, and asking it this question is what made the
  // failure in this file's docstring real (gens 23-28, 2026-08-19). Rename-aware,
  // or a card acknowledged under its old id would settle again under its new one.
  const pending = unacknowledgedCards(group.settled, renameAwareAcks(view.acknowledgedCardIds, renames))
  if (pending.length > 0) await acknowledge(deps, group, pending, await settleContext(deps, group, cards, pending))

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
      `${tag(group.epicId, gen)} ${failed.length} failed launch(es): ` +
        failed.map(l => `${l.cardId}/${l.role}@${l.convId.slice(0, 8)}`).join(', '),
    )
    await noteFailedLaunches(deps, group, failed)
  }

  // THE SUPERVISOR THE REGISTRY STILL CALLS ALIVE. Before this, an overseer whose
  // agent host died without recording an end held `guardBeat` -- and therefore
  // the entire run -- for the life of the broker, logging `overseer alive at gen
  // N; holding the beat` every 45 seconds. The fold has already stopped believing
  // it (`epic-sweep.ts`); this says so, in the log for every corpse and in the
  // baton for the one holding the lease.
  const lost = await reapOverseers(deps, group, gen, view.lease, view.baton)

  // THE SEATS THE REGISTRY HAS NOT CAUGHT UP WITH YET. A card dispatched on the
  // last beat is in NO lane until its agent host connects, which read as "nobody
  // is working this" and sent a second seat into the SAME worktree -- twice on
  // 2026-08-21, once per lane. The baton knows: it recorded the spawn and the
  // conversation id at the moment it happened. Unioned into BOTH lanes because a
  // `dispatch` entry does not say which role went out, and the incident proves
  // both lanes need it. Released the instant `convIds` shows the conversation.
  const pendingSeats = pendingSeatCards({
    baton: view.baton,
    knownConvIds: group.convIds,
    nowMs: deps.now(),
  })
  if (pendingSeats.length > 0) {
    deps.log(
      `${tag(group.epicId, gen)} ${pendingSeats.length} card(s) held for an unattached seat: ` +
        pendingSeats.join(', '),
    )
  }

  const plan = planEpic({
    cards,
    epicId: group.epicId,
    concurrency: run.concurrency,
    inFlight: withPendingSeats(group.inFlight, pendingSeats),
    inVerify: withPendingSeats(group.inVerify, pendingSeats),
    unspawnable: group.unspawnable,
    // THE SAME `settled` the acknowledgement pass above reads, and deliberately
    // the post-rename one: a card acknowledged under its old id must not be
    // dispatchable again under its new one, which is the identical rule
    // `renameAwareAcks` exists for one lane over.
    settled: group.settled,
    // THE CEILING ON THE DISPATCH LANE, from the SAME `get` the run and the baton
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
    // OFF THE LEASE, not off the run -- see the `gen` binding above. Every
    // `expectGen` the beat emits ends up back at the CAS that produced this
    // number, so the two cannot be different copies.
    gen,
    plan,
    // THE SAME UNION the plan was computed from, and it must be: a beat that
    // withheld a card because a seat is arriving has work in flight, and telling
    // `planBeat` otherwise is how a held card reads as a DRY generation, wakes
    // the overseer and parks a run that is simply mid-launch.
    inFlight: withPendingSeats(group.inFlight, pendingSeats),
    overseerAlive: group.overseerAlive,
    // THE TTL ON THAT LIVENESS, from the SAME `get` the generation above came
    // from. Without it `overseerAlive` is an unbounded hold, and the one shape
    // that never lifts -- a supervisor blocked in a Bash call, socket held,
    // events silent, un-reapable -- stops the run for the life of the broker.
    ...leaseTaken(view),
    // A SPENT FACT, keyed on the lease holder rather than on the lane -- see
    // `EpicBeatInput.overseerLost`. The wake this drives moves the lease, so the
    // next beat reads false and the replacement is billed exactly once. Stated
    // unconditionally rather than spread, unlike the two below: those are genuinely
    // ABSENT for a caller that did not compute them, while this one always has an
    // answer once a reaper has run.
    overseerLost: lost !== null,
    ...(ctx.queue ? { queue: ctx.queue } : {}),
    ...(ctx.headroom ? { headroom: ctx.headroom } : {}),
    ...(ctx.forced ? { forced: true } : {}),
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

  const written = await applyBeatPatch(deps, group, gen, beat.patch)
  // THE PROMPTS ARE BUILT AFTER THE RUN IS PERSISTED, and these two lines in
  // this order ARE the fix -- `renderedRun` says why at length. A seat spawned
  // from `run` here is a seat quoting the run as it was before this beat wrote.
  const current = await renderedRun(deps, group, beat, run, written)

  const spawned = await performActions(deps, group, current, beat, {
    gen,
    batonTail: renderEpicLogTail(view.baton),
    plan,
    settled: pending,
    cardLines: plan.rollup?.children.map(c => `${c.card.slug} -- ${c.card.title} (${c.card.status})`) ?? [],
    epicBody: plan.rollup?.card?.bodyPreview ?? '',
    // From the SAME read as the run, so the CAS can ask whether THIS holder is
    // alive rather than whether any overseer is.
    holder: view.lease,
  })

  return finish(deps, group, gen, {
    epicId: group.epicId,
    note: `${beat.note} (${beat.actions.length} action(s), ${spawned.length} spawned)`,
    actions: beat.actions.length,
    spawned,
  })
}
