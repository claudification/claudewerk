/**
 * PERFORMING a beat's actions. `planBeat` decides, `epic-executor.ts` sequences,
 * and this file does the four things a beat can actually do: acknowledge a
 * settle, wake the werk-master, dispatch or verify a card, and settle the run.
 *
 * Split out of the executor so that file stays the ORDER of a beat -- which is
 * its entire contract -- rather than the order plus four spawn recipes.
 */

import { describeBoardDelta, fingerprintDelta } from '../shared/epic-board-fingerprint'
import type { EpicLease } from '../shared/epic-lease'
import type { planEpic } from '../shared/epic-ready'
import { formatUsd } from '../shared/epic-run-caps'
import type { EpicLogEntry } from '../shared/epic-run-types'
import type { EpicRunSnapshot } from '../shared/protocol'
import type { TaskStatus } from '../shared/task-statuses'
import type { EpicAction, EpicBeat } from './epic-beat'
import { completionBody, deathBody, deathLogLine } from './epic-dead-seat-report'
import { epicIo, tag } from './epic-io'
import { forgetArmedEpic } from './epic-registry'
import {
  cardBranch,
  type EpicSpawnCtx,
  type EpicSpawnPlan,
  planWerkMasterSpawn,
  planWerkPlannerSpawn,
  planWerkVerifierSpawn,
  planWerkWorkerSpawn,
} from './epic-spawn-plan'
import {
  type AbandonedSeat,
  type AbandonedWerkMaster,
  type EpicGroup,
  type FailedLeg,
  lostWerkMaster,
  MAX_LAUNCH_ATTEMPTS,
} from './epic-sweep'
import type { BeatDeps, GitDirt } from './epic-types'

/**
 * What a settle needs to know beyond the card id, and every field of it exists
 * only for the DEATH case.
 *
 * Optional as a whole: a caller that passes nothing gets the plain completion
 * wording for every card, which is exactly the behaviour that shipped before the
 * reaper existed.
 */
export interface AcknowledgeContext {
  /** The board lanes this beat read, so a death report can say where the card
   *  was left. */
  lane?: (cardId: string) => TaskStatus | undefined
  /** The project's uncommitted state. `null` means the engine did not look. */
  dirt?: GitDirt | null
}

/**
 * Write a `completion` entry for every settled card the baton has not seen.
 *
 * Deliberately MACHINE-AUTHORED and terse: the werk-worker's own narrative went
 * into its card, and the point of this entry is to record that the card reached
 * a terminal state at all. An agent-authored summary here would be the one thing
 * the whole design says not to trust.
 *
 * TWO WORDINGS, ONE KIND. A card whose seat was REAPED (`group.abandonedSeats`)
 * gets a body that says so, because "the work finished" and "the worker died"
 * want opposite next moves from whoever reads the baton. The `completion` kind is
 * shared on purpose -- see `epic-dead-seat-report.ts` for why a separate kind
 * would settle the card forever.
 */
export async function acknowledge(
  deps: BeatDeps,
  group: EpicGroup,
  pending: readonly string[],
  ctx: AcknowledgeContext = {},
): Promise<void> {
  // LAST SEAT WINS when a card lost two of them this way: the newest reaping is
  // the one whose worktree state is current, and reporting the older one would
  // name a generation two seats ago.
  const reaped = new Map<string, AbandonedSeat>()
  for (const seat of group.abandonedSeats) {
    const prior = reaped.get(seat.cardId)
    if (!prior || seat.gen >= prior.gen) reaped.set(seat.cardId, seat)
  }

  for (const cardId of pending) {
    const seat = reaped.get(cardId)
    if (seat) deps.log(`${tag(group.epicId, seat.gen)} ${deathLogLine(seat)}`)
    const body = seat
      ? deathBody({
          seat,
          lane: ctx.lane?.(cardId),
          branch: cardBranch(group.epicId, cardId),
          dirt: ctx.dirt ?? null,
        })
      : completionBody(cardId)
    const res = await epicIo().appendBaton(deps, group.project, group.epicId, {
      kind: 'completion',
      convId: 'broker',
      cardId,
      body,
    })
    if (!res.ok) deps.log(`${tag(group.epicId, 0)} baton append FAILED for ${cardId}: ${res.error}`)
  }
}

/**
 * Write a `dispatch-failed` entry for every dead-and-silent seat the baton has
 * not recorded.
 *
 * THE POINT OF THE ENTRY: a reader of `log.md` alone must be able to tell
 * "verified" from "never started". Before this, a failed launch left the
 * `dispatch` entry standing and nothing else, so the log read as though a
 * werk-verifier had run and simply declined to say anything -- which is how the
 * 2026-08-20 run burned a generation per sweep on a card no werk-verifier had ever
 * looked at.
 *
 * Machine-authored and terse, same as `acknowledge`. The exit reason we can
 * state honestly from standing state is "ended without producing output"; the
 * exit code itself belongs to the spawn_failed message, which is why that log
 * line now carries the sentinel's stderr (handlers/sentinel.ts).
 */
export async function noteFailedLaunches(deps: BeatDeps, group: EpicGroup, legs: readonly FailedLeg[]): Promise<void> {
  const dead = new Set(group.unspawnable)
  for (const leg of legs) {
    // The bound is stated IN the entry that trips it. A reader following the
    // log forward must not have to count `dispatch-failed` entries to learn
    // that the engine has stopped trying.
    const outcome = dead.has(leg.cardId)
      ? `This card has now lost ${MAX_LAUNCH_ATTEMPTS} or more seats without one of them producing anything. ` +
        'IT WILL NOT BE DISPATCHED OR VERIFIED AGAIN. Something about the card itself makes the seat ' +
        'unlaunchable -- most often an id too long for a worktree name. Rename it, or fix the seat.'
      : 'The card is dispatchable again; this is not a completion.'
    const res = await epicIo().appendBaton(deps, group.project, group.epicId, {
      kind: 'dispatch-failed',
      convId: leg.convId,
      cardId: leg.cardId,
      body:
        `The ${leg.role} dispatched for \`${leg.cardId}\` at generation ${leg.gen} ` +
        `(conversation \`${leg.convId}\`) ENDED WITHOUT PRODUCING ANYTHING -- the launch failed, ` +
        'no work was done and no verdict was written. Grep the broker log for ' +
        `\`Spawn FAILED stderr: conv=${leg.convId.slice(0, 8)}\` for the cause. ${outcome}`,
    })
    if (!res.ok) deps.log(`${tag(group.epicId, leg.gen)} dispatch-failed append FAILED for ${leg.cardId}: ${res.error}`)
  }
}

/**
 * EVERY REAPED SUPERVISOR SAID OUT LOUD, and the one that matters returned.
 *
 * Both halves in one call because they answer one question at one instant, and
 * because `runEpicBeat` is already 19 cyclomatic before this card touches it --
 * a loop and a branch inlined there would be three more, paid by a function that
 * cannot afford them.
 *
 * THE SPLIT BETWEEN THE TWO OUTPUTS is the whole design. The broker LOG gets
 * every corpse, because an ex-werk-master that died three generations ago is a fact
 * about the fleet somebody debugging wants. The BATON gets only the one holding
 * the lease, because the baton is the record of THIS RUN's generations and
 * because the lane it comes from is re-derived from a registry that never forgets
 * -- writing all of them would append the same entries every 45 seconds forever.
 */
export async function reapWerkMasters(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  holder: EpicLease | null,
  baton: readonly EpicLogEntry[],
): Promise<AbandonedWerkMaster | null> {
  for (const dead of group.abandonedWerkMasters) {
    deps.log(
      `${tag(group.epicId, gen)} werk-master ${dead.convId.slice(0, 8)} (gen ${dead.gen}) REAPED: status ` +
        `${dead.status} but no socket and silent for ${Math.round(dead.silentForMs / 1000)}s`,
    )
  }
  const lost = lostWerkMaster(group, holder)
  if (lost) await noteLostWerkMaster(deps, group, gen, lost, baton)
  return lost
}

/**
 * Write a `werk-master-lost` entry for a supervisor the engine has just reaped.
 *
 * THE POINT OF THE ENTRY, which is the whole reason the card exists: a run whose
 * werk-master's agent host died without recording an end used to write `werk-master
 * alive at gen N; holding the beat` to the BROKER LOG every 45 seconds, forever,
 * and nothing at all to the baton. The baton is the only thing a fresh werk-master
 * generation reads about the past, so from inside the run the death was
 * invisible: generation N+1 looked exactly like a generation that followed a
 * finished turn. This is what makes those two tellable apart.
 *
 * AT MOST ONCE PER DEAD HOLDER, and it is checked against the baton for the same
 * reason `unacknowledgedFailedLegs` is: the lane it comes from is re-derived from
 * a registry that never forgets a conversation, so an unguarded write would
 * append the same entry every tick. The tail is a sufficient window here in a way
 * it is not for a card settle -- the wake this accompanies moves the lease and
 * makes the fact unaskable on the next beat, so the only case that can repeat is
 * a lease the CAS keeps refusing, which cannot put 20 entries between two
 * attempts.
 *
 * Machine-authored and terse, same as `acknowledge` and `noteFailedLaunches`, and
 * it quotes the EVIDENCE rather than the verdict: a human who does not believe
 * the engine can check every number in it against the conversation registry.
 */
async function noteLostWerkMaster(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  dead: AbandonedWerkMaster,
  baton: readonly EpicLogEntry[],
): Promise<void> {
  if (baton.some(e => e.kind === 'werk-master-lost' && e.convId === dead.convId)) return
  const silentMin = Math.round(dead.silentForMs / 60_000)
  const res = await epicIo().appendBaton(deps, group.project, group.epicId, {
    kind: 'werk-master-lost',
    convId: dead.convId,
    body:
      `The WERK-MASTER of generation ${dead.gen} (conversation \`${dead.convId}\`) was REAPED: the conversation ` +
      `registry still reported it as \`${dead.status}\`, but it has held no agent-host connection and produced ` +
      `nothing for ${silentMin} minute(s) (last sign of life ${new Date(dead.lastActivity).toISOString()}). ` +
      'Its end was never recorded, so the engine had been holding every beat for it. A replacement generation ' +
      'is being woken. THIS GENERATION FOLLOWS A DEATH, NOT A FINISHED TURN -- whatever that werk-master was ' +
      'part-way through (a merge, a card edit, an answer to a question) may be half-done, so trust the board ' +
      'and git over anything the baton implies was completed.',
  })
  if (!res.ok) deps.log(`${tag(group.epicId, gen)} werk-master-lost append FAILED for ${dead.convId}: ${res.error}`)
}

function spawnCtx(group: EpicGroup, gen: number): EpicSpawnCtx {
  return { project: group.project, projectRoot: group.project, epicId: group.epicId, gen }
}

/**
 * Take the werk-master lease. Returns the granted generation, or null.
 *
 * A REFUSAL IS NORMAL, not an error: the CAS is what makes a double wake safe,
 * so two sweeps racing the same settle is the case this is built for rather than
 * a case it tolerates.
 */
async function takeLease(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  convId: string,
  expectGen: number,
  what: string,
  holder?: EpicLease | null,
): Promise<number | null> {
  const res = await epicIo().sendEpicOp(deps, group.project, {
    op: 'lease',
    epicId: group.epicId,
    // Is THE HOLDER alive -- not "is any werk-master alive", which reads true in
    // exactly the case this check exists to refuse.
    lease: { convId, expectGen, holderAlive: holderIsAlive(group, holder) },
  })
  if (!res.ok || !res.lease?.granted) {
    deps.log(`${tag(group.epicId, gen)} ${what} refused: ${res.lease?.reason ?? res.error ?? 'unknown'}`)
    return null
  }
  return res.lease.gen
}

/**
 * Does the conversation named on the lease still live?
 *
 * With no holder known -- the run artifact was unreadable, or nothing has ever
 * taken it -- fall back to "is any werk-master alive", which is the conservative
 * answer: it refuses a wake rather than stacking a second werk-master.
 */
function holderIsAlive(group: EpicGroup, holder?: EpicLease | null): boolean {
  if (!holder?.convId) return group.werkMasterAlive
  return group.liveWerkMasters.includes(holder.convId)
}

/**
 * SWAP THE REAL CONVERSATION ID IN over the `pending-` placeholder the wake took
 * the lease under. Same generation, so this is not a second wake.
 *
 * A failure is logged and swallowed on purpose: the werk-master is already running,
 * and refusing to proceed because the bookkeeping write missed would trade a
 * wrong holder id for a lost generation. The log line is what makes the mismatch
 * findable (LOG EVERYTHING).
 */
async function adoptLease(deps: BeatDeps, group: EpicGroup, gen: number, convId: string, what: string): Promise<void> {
  const res = await epicIo().sendEpicOp(deps, group.project, {
    op: 'lease',
    epicId: group.epicId,
    lease: { convId, expectGen: gen, holderAlive: true, adopt: true },
  })
  if (!res.ok || !res.lease?.granted) {
    deps.log(
      `${tag(group.epicId, gen)} ${what} lease adopt FAILED for ${convId.slice(0, 8)}: ` +
        `${res.lease?.reason ?? res.error ?? 'unknown'} -- the board still names the placeholder`,
    )
    return
  }
  deps.log(`${tag(group.epicId, gen)} ${what} lease adopted by ${convId.slice(0, 8)} at gen ${gen}`)
}

/** Spawn a planned seat and say so. Returns the conversation id, or null. */
async function spawnSeat(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  spawn: EpicSpawnPlan,
  what: string,
): Promise<string | null> {
  const out = await epicIo().dispatchSpawn(spawn, deps.spawnContext)
  if (!out.ok) {
    deps.log(`${tag(group.epicId, gen)} ${what} spawn FAILED: ${out.error}`)
    return null
  }
  deps.log(`${tag(group.epicId, gen)} ${what} spawned: ${out.conversationId}`)
  return out.conversationId
}

/**
 * Take the lease, then spawn the werk-master.
 *
 * `action.expectGen` IS THE LEASE'S OWN GENERATION -- `runEpicBeat` reads it off
 * `view.lease` and hands it to `planBeat`, which puts it here. There is nothing
 * to reconcile: the run artifact carries no generation any more
 * (`EpicRunMeta`), so the wake and the CAS cannot be quoting two different
 * copies of it, which is the state that deadlocked `epic-the-wall-ii` for hours
 * on 2026-08-20 (`stale wake: expected gen 12, epic is at gen 11`, spawning
 * nothing, every panel surface reporting RUNNING).
 *
 * The race protection is unchanged: two beats reading the same lease still send
 * the same generation, and exactly one of them is granted.
 */
async function wakeWerkMaster(
  deps: BeatDeps,
  group: EpicGroup,
  run: EpicRunSnapshot,
  action: Extract<EpicAction, { kind: 'wake-werk-master' }>,
  ctx: ActionContext,
): Promise<string | null> {
  const expectGen = action.expectGen
  const convId = `pending-${group.epicId}-${expectGen + 1}`
  const gen = await takeLease(deps, group, expectGen, convId, expectGen, 'wake', ctx.holder)
  if (gen === null) return null

  const spawned = await spawnSeat(
    deps,
    group,
    gen,
    planWerkMasterSpawn(spawnCtx(group, gen), {
      projectUri: group.project,
      projectRoot: group.project,
      run: { ...run, gen },
      plan: ctx.plan,
      batonTail: ctx.batonTail,
      wake: action.reason,
      settled: ctx.settled.map(c => `${c} settled`),
      // THE BEAT'S OWN CLOCK, so the elapsed minutes in the budget sentence are
      // measured at the instant every other number in it was.
      nowMs: deps.now(),
    }),
    'werk-master',
  )
  if (spawned) await adoptLease(deps, group, gen, spawned, 'werk-master')
  return spawned
}

/** Dispatch or verify one card. */
async function spawnForCard(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  cardId: string,
  role: 'dispatch' | 'verify',
  /** The card's `depends_on`, for the werk-worker's base check. Ignored for a
   *  werk-verifier, which reviews a diff and has no worktree to merge into. */
  dependsOn: readonly string[] = [],
): Promise<string | null> {
  const io = epicIo()
  const ctx = spawnCtx(group, gen)
  const spawn =
    role === 'dispatch' ? planWerkWorkerSpawn(ctx, cardId, 'main', dependsOn) : planWerkVerifierSpawn(ctx, cardId)
  const out = await io.dispatchSpawn(spawn, deps.spawnContext)
  if (!out.ok) {
    deps.log(`${tag(group.epicId, gen)} ${role} FAILED for ${cardId}: ${out.error}`)
    return null
  }
  await io.appendBaton(deps, group.project, group.epicId, {
    kind: 'dispatch',
    convId: out.conversationId,
    cardId,
    body: `${role === 'dispatch' ? 'WerkWorker' : 'WerkVerifier'} dispatched for \`${cardId}\` at generation ${gen}.`,
  })
  deps.log(`${tag(group.epicId, gen)} ${role} ${cardId} -> ${out.conversationId}`)
  return out.conversationId
}

/**
 * GENERATION 0: take the lease and spawn the werk-planner into the werk-master seat,
 * recording the board's fingerprint as the baseline in the SAME patch.
 *
 * The baseline is written before the werk-planner can touch anything. Writing it
 * afterwards -- or letting the werk-planner report it -- would compare the board
 * against a snapshot the werk-planner had already influenced, which is the one thing
 * this comparison exists to avoid.
 */
async function spawnWerkPlanner(
  deps: BeatDeps,
  group: EpicGroup,
  run: EpicRunSnapshot,
  action: Extract<EpicAction, { kind: 'plan' }>,
  ctx: ActionContext,
): Promise<string | null> {
  const io = epicIo()
  // Same authority as the wake, and from the same place: the lease on the card.
  const expectGen = ctx.gen
  const gen = await takeLease(
    deps,
    group,
    expectGen,
    `pending-${group.epicId}-werk-planner`,
    expectGen,
    'werk-planner',
    ctx.holder,
  )
  if (gen === null) return null

  await io.sendEpicOp(deps, group.project, {
    op: 'patch',
    epicId: group.epicId,
    patch: { planBaseline: action.baseline },
  })
  const convId = await spawnSeat(
    deps,
    group,
    gen,
    planWerkPlannerSpawn(spawnCtx(group, gen), {
      projectUri: group.project,
      projectRoot: group.project,
      run: { ...run, gen },
      plan: ctx.plan,
      cardLines: ctx.cardLines,
      epicBody: ctx.epicBody,
    }),
    'werk-planner',
  )
  if (!convId) return null
  await adoptLease(deps, group, gen, convId, 'werk-planner')

  await io.appendBaton(deps, group.project, group.epicId, {
    kind: 'intent',
    convId,
    body:
      'Planning generation dispatched. Nothing else runs until it exits. It reads the epic intent and every ' +
      'card, closes what is already done, files what is missing, and writes the `depends_on` edges that were ' +
      'never declared -- so dispatch arithmetic has a complete graph to work from.',
  })
  return convId
}

/**
 * The run stops here: post the checkpoint, release the lease, stop sweeping, say
 * so at the generation.
 *
 * Three call sites do exactly this -- a plan CHECKPOINT, a park and a complete --
 * and the order carries meaning. The baton entry lands BEFORE the release, so
 * whoever reads the board next finds the reason the run stopped rather than an
 * idle lease with nothing to explain it. `forgetArmedEpic` is not optional: a
 * stopped run left registered would be beaten every 45s for the life of the
 * broker, doing nothing.
 */
async function standDown(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  checkpoint: string,
  note: string,
): Promise<void> {
  const io = epicIo()
  await io.appendBaton(deps, group.project, group.epicId, { kind: 'checkpoint', convId: 'broker', body: checkpoint })
  await io.sendEpicOp(deps, group.project, { op: 'release', epicId: group.epicId })
  forgetArmedEpic(group.project, group.epicId)
  deps.log(`${tag(group.epicId, gen)} ${note}`)
}

/**
 * The planning generation settled. Either the board is as it was -- proceed --
 * or it was rewritten, and what happens then depends on WHICH plan this was.
 *
 * `planned` is set in EVERY branch. A checkpoint is not a retry: resuming after
 * one must go straight to the next beat, or approving a plan would re-run the
 * werk-planner that produced it, forever.
 *
 * GENERATION 0'S CHECKPOINT IS A GATE. Nothing has been dispatched yet, the whole
 * run is downstream of whatever the werk-planner decided, and stopping costs
 * nothing because there is nothing in flight to strand.
 *
 * A LEG BOUNDARY'S CHECKPOINT IS A NOTIFICATION. Jonas chose `auto`: re-plan and
 * continue. A re-plan that does its job CHANGES the board -- that is the entire
 * reason the boundary exists -- so gating on it would stop the run on every single
 * leg and train exactly the reflex a checkpoint must never train, which is
 * clicking through it. The human-visible RECORD is what is being kept, and it is
 * kept: the same delta, in the same baton, naming the cards rather than counting
 * them. `beat.gate` is the pure decision's, so this function never has to re-derive
 * which kind of plan it just resolved.
 */
async function resolvePlanning(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  action: Extract<EpicAction, { kind: 'plan-accept' | 'plan-checkpoint' }>,
): Promise<void> {
  const io = epicIo()
  const patch: Record<string, unknown> = { planned: true, planBaseline: '' }
  if (action.kind === 'plan-accept') {
    await io.sendEpicOp(deps, group.project, { op: 'patch', epicId: group.epicId, patch })
    await io.sendEpicOp(deps, group.project, { op: 'release', epicId: group.epicId })
    deps.log(`${tag(group.epicId, gen)} plan accepted: board unchanged, proceeding to the first beat`)
    return
  }

  const { added, removed } = fingerprintDelta(action.before, action.after)
  const changed = describeBoardDelta(action.before, action.after)
  if (!action.gate) {
    await io.sendEpicOp(deps, group.project, { op: 'patch', epicId: group.epicId, patch })
    await io.appendBaton(deps, group.project, group.epicId, {
      kind: 'leg',
      convId: 'broker',
      body:
        `RE-PLAN COMPLETE -- leg ${action.leg} starts here. The werk-planner rewrote the board against the tree ` +
        `as it now stands, and the run CONTINUES rather than waiting (the boundary is set to auto). ` +
        `${changed.length} change(s):\n${changed.map(c => `  - ${c}`).join('\n')}\n` +
        "Read the werk-planner's `intent` entry above for why. To stop here instead, pause the run.",
    })
    // The lease goes back exactly as `plan-accept` releases it -- the werk-planner
    // has exited and the next beat must be free to dispatch under the new plan.
    await io.sendEpicOp(deps, group.project, { op: 'release', epicId: group.epicId })
    deps.log(`${tag(group.epicId, gen)} leg ${action.leg} re-plan: ${changed.length} board change(s); continuing`)
    return
  }

  await io.sendEpicOp(deps, group.project, {
    op: 'patch',
    epicId: group.epicId,
    patch: { ...patch, status: 'paused' },
  })
  await standDown(
    deps,
    group,
    gen,
    'CHECKPOINT -- the planning generation changed the board, so nothing has been dispatched. ' +
      `${added.length} card state(s) added or changed, ${removed.length} gone:\n` +
      `${changed.map(c => `  - ${c}`).join('\n')}\n` +
      "Read the werk-planner's `intent` entry above for what it decided and why, then RUN again to accept the plan " +
      'and start beat 1 -- resuming does NOT re-plan.',
    `plan CHECKPOINT: +${added.length}/-${removed.length}; awaiting Jonas`,
  )
}

/**
 * A LEG ENDED. The scalars are already on disk -- `applyBeatPatch` ran before this
 * -- so all that is left is to say so where somebody will find it.
 *
 * THE BATON AND NOT `deps.log`, for `recordFriction`'s reason and one more of its
 * own: this is the moment the engine decided to let a model reshape Jonas's board
 * without asking. The record of that decision has to outlive a container restart,
 * and it has to sit in the file a fresh werk-master reads about the past -- which
 * is exactly one file, and it is this one.
 *
 * IT NAMES THE MONEY, because the boundary is otherwise unfalsifiable. "Leg 2
 * ended" tells a reader nothing they can check; "leg 2: $212.40 of $200.00, ended
 * because the budget was spent and everything it dispatched settled" tells them
 * both what happened and what the next leg is allowed.
 */
async function recordLegEnd(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  action: Extract<EpicAction, { kind: 'leg-end' }>,
): Promise<void> {
  const why =
    action.reason === 'budget'
      ? 'the leg budget was spent, dispatch stopped, and everything it had out has settled'
      : `nothing ready was left to dispatch (${action.detail ?? 'unknown'})`
  const res = await epicIo().appendBaton(deps, group.project, group.epicId, {
    kind: 'leg',
    convId: 'broker',
    body:
      `LEG ${action.leg} ENDED -- ${formatUsd(action.spentUsd)} of a ${formatUsd(action.budgetUsd)} leg budget. ` +
      `Ended because ${why}. Leg ${action.leg + 1} opens with a full budget and begins with a RE-PLAN: the ` +
      'werk-planner re-runs against the unfinished work, rewriting the `depends_on` edges against the code as it ' +
      'NOW exists. That drift repair is the reason this boundary exists -- the plan of record decays as work ' +
      'lands. The run does NOT wait for a human here.',
  })
  if (!res.ok) deps.log(`${tag(group.epicId, gen)} leg-end append FAILED: ${res.error}`)
}

/** Park or complete: patch the run and stop. Both are terminal for the sweep. */
async function settleRun(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  action: Extract<EpicAction, { kind: 'park' | 'complete' }>,
): Promise<void> {
  const io = epicIo()
  const status = action.kind === 'complete' ? 'complete' : 'paused'
  const body = action.kind === 'complete' ? 'Every child is terminal. Run complete.' : `Run PARKED: ${action.reason}`
  await io.sendEpicOp(deps, group.project, { op: 'patch', epicId: group.epicId, patch: { status } })
  await standDown(deps, group, gen, body, `${status}: ${body}`)
}

/**
 * REPEATED MECHANICAL WORK IS A LESSON, NOT A CHORE -- written down where
 * something can read it back.
 *
 * THE BATON AND NOT `deps.log`, which is the entire requirement: a broker log
 * line is a lesson nobody greps, and by the time anyone wonders why an epic cost
 * what it cost the container has been restarted. The baton is append-only,
 * per-epic, durable, already carries the run's whole history, and is already the
 * one file a fresh werk-master reads about the past.
 *
 * THE LEDGER WRITE IS NOT HERE, and that is a boundary rather than a shortcut.
 * Folding lessons into the durable per-project ledger is `werk-retrospect-hook`'s
 * mechanism -- it exists, it is LLM-free, and it is emphatic that nobody should
 * build a third lessons system. This entry is the INPUT that card was waiting
 * for: structured, typed (`kind: 'friction'`), attributed to the engine, and
 * keyed by an operation string so a fold can group by it without a model.
 *
 * NO `cardId`. Friction is a fact about the RUN -- the same operation repeated
 * across several cards is precisely what makes it friction -- and hanging it on
 * whichever card happened to be third would make it look like that card's
 * problem.
 */
async function recordFriction(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  action: Extract<EpicAction, { kind: 'friction' }>,
): Promise<void> {
  const res = await epicIo().appendBaton(deps, group.project, group.epicId, {
    kind: 'friction',
    convId: 'broker',
    body: `FRICTION x${action.count} -- ${action.operation}. ${action.detail}`,
  })
  if (!res.ok) deps.log(`${tag(group.epicId, gen)} friction append FAILED: ${res.error}`)
}

export interface ActionContext {
  /**
   * The werk-master generation this beat is acting AT, read off the lease on the
   * epic card by `runEpicBeat`.
   *
   * Every seat this beat spawns is tagged with it and every log line quotes it,
   * so it is handed down once rather than re-derived per performer. It is not on
   * the run any more, and that is the point of the card that removed it: one
   * copy, on the card, which is what the CAS compares.
   */
  gen: number
  batonTail: string
  plan: ReturnType<typeof planEpic>
  settled: readonly string[]
  /** Planning generation only: every card under the epic, one line each. */
  cardLines: string[]
  /** Planning generation only: the epic card's own body -- where intent lives. */
  epicBody: string
  /**
   * The lease as it stands on the board, from the SAME read the run came from.
   * The CAS needs the holder's identity to ask whether that holder is alive; it
   * was being fetched and thrown away, so the check ran on "is any werk-master
   * alive" and could never refuse.
   */
  holder: EpicLease | null
}

/** Everything a performer is handed. One bag so the map's entries share a
 *  signature and adding an action kind never re-threads the others. */
interface Perform {
  deps: BeatDeps
  group: EpicGroup
  run: EpicRunSnapshot
  ctx: ActionContext
}

/**
 * Action kind -> the thing that does it. A table rather than the if-chain this
 * was, because the chain had grown to seven kinds and the planning cases had to
 * be wedged in ahead of `dispatch` -- at which point the ORDER of the branches
 * was carrying meaning it does not actually have. Order lives in `beat.actions`;
 * this is a lookup, and it should look like one.
 *
 * Each entry returns a spawned conversation id or null, so the caller's
 * collection is one rule instead of one per branch.
 */
type Performer = (p: Perform, action: never) => Promise<string | null>

const PERFORMERS: Record<EpicAction['kind'], Performer> = {
  'wake-werk-master': (p, a: Extract<EpicAction, { kind: 'wake-werk-master' }>) =>
    wakeWerkMaster(p.deps, p.group, p.run, a, p.ctx),
  plan: (p, a: Extract<EpicAction, { kind: 'plan' }>) => spawnWerkPlanner(p.deps, p.group, p.run, a, p.ctx),
  'plan-accept': (p, a: Extract<EpicAction, { kind: 'plan-accept' }>) =>
    resolvePlanning(p.deps, p.group, p.ctx.gen, a).then(() => null),
  'plan-checkpoint': (p, a: Extract<EpicAction, { kind: 'plan-checkpoint' }>) =>
    resolvePlanning(p.deps, p.group, p.ctx.gen, a).then(() => null),
  dispatch: (p, a: Extract<EpicAction, { kind: 'dispatch' }>) =>
    spawnForCard(p.deps, p.group, p.ctx.gen, a.cardId, 'dispatch', a.dependsOn ?? []),
  verify: (p, a: Extract<EpicAction, { kind: 'verify' }>) =>
    spawnForCard(p.deps, p.group, p.ctx.gen, a.cardId, 'verify'),
  park: (p, a: Extract<EpicAction, { kind: 'park' }>) => settleRun(p.deps, p.group, p.ctx.gen, a).then(() => null),
  complete: (p, a: Extract<EpicAction, { kind: 'complete' }>) =>
    settleRun(p.deps, p.group, p.ctx.gen, a).then(() => null),
  friction: (p, a: Extract<EpicAction, { kind: 'friction' }>) =>
    recordFriction(p.deps, p.group, p.ctx.gen, a).then(() => null),
  'leg-end': (p, a: Extract<EpicAction, { kind: 'leg-end' }>) =>
    recordLegEnd(p.deps, p.group, p.ctx.gen, a).then(() => null),
} as Record<EpicAction['kind'], Performer>

/**
 * THE ACTIONS THAT PUT THE RUN IN A PROMPT -- the two entries above that read
 * `p.run` rather than only `p.ctx`.
 *
 * It is a list beside the table rather than a flag on the action because the
 * caller's question is asked BEFORE any performer runs: `epic-executor.ts` has
 * to know whether it owes a fresh read of `run.md` before it hands one over, and
 * by the time a performer could answer, the stale object is already in the
 * prompt.
 *
 * IF A THIRD PERFORMER STARTS RENDERING THE RUN, ADD ITS KIND HERE. Forgetting
 * is not loud: the seat spawns fine and its prompt simply quotes a run from
 * before this beat's write, which is the exact defect that cost this epic nine
 * generations of wrong budget arithmetic.
 */
const RUN_RENDERING_ACTIONS: readonly EpicAction['kind'][] = ['wake-werk-master', 'plan']

export function rendersRunState(beat: EpicBeat): boolean {
  return beat.actions.some(a => RUN_RENDERING_ACTIONS.includes(a.kind))
}

/**
 * Perform a beat's actions IN ORDER, collecting the conversations spawned.
 *
 * Sequential rather than concurrent on purpose: `dispatch` actions all consume
 * from the same capacity ledger, and firing them together would let the fleet
 * overshoot the concurrency ceiling by however many happened to be in the batch.
 */
export async function performActions(
  deps: BeatDeps,
  group: EpicGroup,
  run: EpicRunSnapshot,
  beat: EpicBeat,
  ctx: ActionContext,
): Promise<string[]> {
  const spawned: string[] = []
  const p: Perform = { deps, group, run, ctx }
  for (const action of beat.actions) {
    const id = await PERFORMERS[action.kind](p, action as never)
    if (id) spawned.push(id)
  }
  return spawned
}
