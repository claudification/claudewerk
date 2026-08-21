/**
 * PERFORMING a beat's actions. `planBeat` decides, `epic-executor.ts` sequences,
 * and this file does the four things a beat can actually do: acknowledge a
 * settle, wake the overseer, dispatch or verify a card, and settle the run.
 *
 * Split out of the executor so that file stays the ORDER of a beat -- which is
 * its entire contract -- rather than the order plus four spawn recipes.
 */

import { fingerprintDelta } from '../shared/epic-board-fingerprint'
import type { EpicLease } from '../shared/epic-lease'
import type { planEpic } from '../shared/epic-ready'
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
  planImplementerSpawn,
  planOverseerSpawn,
  planPlannerSpawn,
  planVerifierSpawn,
} from './epic-spawn-plan'
import {
  type AbandonedOverseer,
  type AbandonedSeat,
  type EpicGroup,
  type FailedLeg,
  lostOverseer,
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
 * Deliberately MACHINE-AUTHORED and terse: the implementer's own narrative went
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
 * verifier had run and simply declined to say anything -- which is how the
 * 2026-08-20 run burned a generation per sweep on a card no verifier had ever
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
 * every corpse, because an ex-overseer that died three generations ago is a fact
 * about the fleet somebody debugging wants. The BATON gets only the one holding
 * the lease, because the baton is the record of THIS RUN's generations and
 * because the lane it comes from is re-derived from a registry that never forgets
 * -- writing all of them would append the same entries every 45 seconds forever.
 */
export async function reapOverseers(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  holder: EpicLease | null,
  baton: readonly EpicLogEntry[],
): Promise<AbandonedOverseer | null> {
  for (const dead of group.abandonedOverseers) {
    deps.log(
      `${tag(group.epicId, gen)} overseer ${dead.convId.slice(0, 8)} (gen ${dead.gen}) REAPED: status ` +
        `${dead.status} but no socket and silent for ${Math.round(dead.silentForMs / 1000)}s`,
    )
  }
  const lost = lostOverseer(group, holder)
  if (lost) await noteLostOverseer(deps, group, gen, lost, baton)
  return lost
}

/**
 * Write an `overseer-lost` entry for a supervisor the engine has just reaped.
 *
 * THE POINT OF THE ENTRY, which is the whole reason the card exists: a run whose
 * overseer's agent host died without recording an end used to write `overseer
 * alive at gen N; holding the beat` to the BROKER LOG every 45 seconds, forever,
 * and nothing at all to the baton. The baton is the only thing a fresh overseer
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
async function noteLostOverseer(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  dead: AbandonedOverseer,
  baton: readonly EpicLogEntry[],
): Promise<void> {
  if (baton.some(e => e.kind === 'overseer-lost' && e.convId === dead.convId)) return
  const silentMin = Math.round(dead.silentForMs / 60_000)
  const res = await epicIo().appendBaton(deps, group.project, group.epicId, {
    kind: 'overseer-lost',
    convId: dead.convId,
    body:
      `The OVERSEER of generation ${dead.gen} (conversation \`${dead.convId}\`) was REAPED: the conversation ` +
      `registry still reported it as \`${dead.status}\`, but it has held no agent-host connection and produced ` +
      `nothing for ${silentMin} minute(s) (last sign of life ${new Date(dead.lastActivity).toISOString()}). ` +
      'Its end was never recorded, so the engine had been holding every beat for it. A replacement generation ' +
      'is being woken. THIS GENERATION FOLLOWS A DEATH, NOT A FINISHED TURN -- whatever that overseer was ' +
      'part-way through (a merge, a card edit, an answer to a question) may be half-done, so trust the board ' +
      'and git over anything the baton implies was completed.',
  })
  if (!res.ok) deps.log(`${tag(group.epicId, gen)} overseer-lost append FAILED for ${dead.convId}: ${res.error}`)
}

function spawnCtx(group: EpicGroup, gen: number): EpicSpawnCtx {
  return { project: group.project, projectRoot: group.project, epicId: group.epicId, gen }
}

/**
 * Take the overseer lease. Returns the granted generation, or null.
 *
 * A REFUSAL IS NORMAL, not an error: the CAS is what makes a double wake safe,
 * so two sweeps racing the same settle is the case this is built for rather than
 * a case it tolerates.
 */
async function takeLease(
  deps: BeatDeps,
  group: EpicGroup,
  run: EpicRunSnapshot,
  convId: string,
  expectGen: number,
  what: string,
  holder?: EpicLease | null,
): Promise<number | null> {
  const res = await epicIo().sendEpicOp(deps, group.project, {
    op: 'lease',
    epicId: group.epicId,
    // Is THE HOLDER alive -- not "is any overseer alive", which reads true in
    // exactly the case this check exists to refuse.
    lease: { convId, expectGen, holderAlive: holderIsAlive(group, holder) },
  })
  if (!res.ok || !res.lease?.granted) {
    deps.log(`${tag(group.epicId, run.gen)} ${what} refused: ${res.lease?.reason ?? res.error ?? 'unknown'}`)
    return null
  }
  return res.lease.gen
}

/**
 * Does the conversation named on the lease still live?
 *
 * With no holder known -- the run artifact was unreadable, or nothing has ever
 * taken it -- fall back to "is any overseer alive", which is the conservative
 * answer: it refuses a wake rather than stacking a second overseer.
 */
function holderIsAlive(group: EpicGroup, holder?: EpicLease | null): boolean {
  if (!holder?.convId) return group.overseerAlive
  return group.liveOverseers.includes(holder.convId)
}

/**
 * SWAP THE REAL CONVERSATION ID IN over the `pending-` placeholder the wake took
 * the lease under. Same generation, so this is not a second wake.
 *
 * A failure is logged and swallowed on purpose: the overseer is already running,
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
 * The generation the CAS is asked about. THE LEASE IS THE AUTHORITY.
 *
 * `action.expectGen` comes from the run file, and the run file's `gen` is a
 * MIRROR -- the sentinel writes it when a lease is granted (epic-handlers.ts
 * `lease`). A mirror can drift: `run.md` is a markdown artifact whose digest an
 * overseer rewrites every generation, and rewriting the body with the
 * frontmatter attached rewrites the counter too.
 *
 * When it drifts the CAS can never agree with itself again, because the wake
 * quotes the run and `evaluateLease` compares against the card. That is not a
 * theoretical hazard: on 2026-08-20 `epic-the-wall-ii` beat every 45s for hours
 * on `stale wake: expected gen 12, epic is at gen 11`, spawning nothing, while
 * every surface in the panel said RUNNING.
 *
 * Quoting the lease we just read keeps the race protection intact -- two beats
 * reading the same lease still send the same generation and exactly one wins --
 * and makes a drifted mirror self-heal, since a granted lease rewrites it.
 */
function casGen(
  deps: BeatDeps,
  group: EpicGroup,
  run: EpicRunSnapshot,
  expectGen: number,
  holder?: EpicLease | null,
): number {
  const onBoard = holder?.gen
  if (onBoard === undefined || onBoard === expectGen) return expectGen
  deps.log(
    `${tag(group.epicId, run.gen)} generation DRIFT: the run file says ${expectGen}, the lease on the card ` +
      `says ${onBoard} -- quoting the lease, which is what the CAS compares against`,
  )
  return onBoard
}

/** Take the lease, then spawn the overseer. */
async function wakeOverseer(
  deps: BeatDeps,
  group: EpicGroup,
  run: EpicRunSnapshot,
  action: Extract<EpicAction, { kind: 'wake-overseer' }>,
  ctx: ActionContext,
): Promise<string | null> {
  const expectGen = casGen(deps, group, run, action.expectGen, ctx.holder)
  const convId = `pending-${group.epicId}-${expectGen + 1}`
  const gen = await takeLease(deps, group, run, convId, expectGen, 'wake', ctx.holder)
  if (gen === null) return null

  const spawned = await spawnSeat(
    deps,
    group,
    gen,
    planOverseerSpawn(spawnCtx(group, gen), {
      projectUri: group.project,
      projectRoot: group.project,
      run: { ...run, gen },
      plan: ctx.plan,
      batonTail: ctx.batonTail,
      wake: action.reason,
      settled: ctx.settled.map(c => `${c} settled`),
    }),
    'overseer',
  )
  if (spawned) await adoptLease(deps, group, gen, spawned, 'overseer')
  return spawned
}

/** Dispatch or verify one card. */
async function spawnForCard(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  cardId: string,
  role: 'dispatch' | 'verify',
  /** The card's `depends_on`, for the implementer's base check. Ignored for a
   *  verifier, which reviews a diff and has no worktree to merge into. */
  dependsOn: readonly string[] = [],
): Promise<string | null> {
  const io = epicIo()
  const ctx = spawnCtx(group, gen)
  const spawn =
    role === 'dispatch' ? planImplementerSpawn(ctx, cardId, 'main', dependsOn) : planVerifierSpawn(ctx, cardId)
  const out = await io.dispatchSpawn(spawn, deps.spawnContext)
  if (!out.ok) {
    deps.log(`${tag(group.epicId, gen)} ${role} FAILED for ${cardId}: ${out.error}`)
    return null
  }
  await io.appendBaton(deps, group.project, group.epicId, {
    kind: 'dispatch',
    convId: out.conversationId,
    cardId,
    body: `${role === 'dispatch' ? 'Implementer' : 'Verifier'} dispatched for \`${cardId}\` at generation ${gen}.`,
  })
  deps.log(`${tag(group.epicId, gen)} ${role} ${cardId} -> ${out.conversationId}`)
  return out.conversationId
}

/**
 * GENERATION 0: take the lease and spawn the planner into the overseer seat,
 * recording the board's fingerprint as the baseline in the SAME patch.
 *
 * The baseline is written before the planner can touch anything. Writing it
 * afterwards -- or letting the planner report it -- would compare the board
 * against a snapshot the planner had already influenced, which is the one thing
 * this comparison exists to avoid.
 */
async function spawnPlanner(
  deps: BeatDeps,
  group: EpicGroup,
  run: EpicRunSnapshot,
  action: Extract<EpicAction, { kind: 'plan' }>,
  ctx: ActionContext,
): Promise<string | null> {
  const io = epicIo()
  // Same authority as the wake: the lease decides, the run file only mirrors.
  const expectGen = casGen(deps, group, run, run.gen, ctx.holder)
  const gen = await takeLease(deps, group, run, `pending-${group.epicId}-planner`, expectGen, 'planner', ctx.holder)
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
    planPlannerSpawn(spawnCtx(group, gen), {
      projectUri: group.project,
      projectRoot: group.project,
      run: { ...run, gen },
      plan: ctx.plan,
      cardLines: ctx.cardLines,
      epicBody: ctx.epicBody,
    }),
    'planner',
  )
  if (!convId) return null
  await adoptLease(deps, group, gen, convId, 'planner')

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
 * The planning generation settled. Either the board is as it was -- proceed --
 * or it was rewritten, in which case the run stops and Jonas reads the plan
 * before a single implementer goes out.
 *
 * `planned` is set in BOTH branches. A checkpoint is not a retry: resuming after
 * one must go straight to beat 1, or approving a plan would re-run the planner
 * that produced it, forever.
 */
async function resolvePlanning(
  deps: BeatDeps,
  group: EpicGroup,
  run: EpicRunSnapshot,
  action: Extract<EpicAction, { kind: 'plan-accept' | 'plan-checkpoint' }>,
): Promise<void> {
  const io = epicIo()
  const patch: Record<string, unknown> = { planned: true, planBaseline: '' }
  if (action.kind === 'plan-accept') {
    await io.sendEpicOp(deps, group.project, { op: 'patch', epicId: group.epicId, patch })
    await io.sendEpicOp(deps, group.project, { op: 'release', epicId: group.epicId })
    deps.log(`${tag(group.epicId, run.gen)} plan accepted: board unchanged, proceeding to the first beat`)
    return
  }

  const { added, removed } = fingerprintDelta(action.before, action.after)
  await io.sendEpicOp(deps, group.project, {
    op: 'patch',
    epicId: group.epicId,
    patch: { ...patch, status: 'paused' },
  })
  await io.appendBaton(deps, group.project, group.epicId, {
    kind: 'checkpoint',
    convId: 'broker',
    body:
      'CHECKPOINT -- the planning generation changed the board, so nothing has been dispatched. ' +
      `${added.length} card state(s) added or changed, ${removed.length} gone. ` +
      "Read the planner's `intent` entry above for what it decided and why, then RUN again to accept the plan " +
      'and start beat 1 -- resuming does NOT re-plan.',
  })
  await io.sendEpicOp(deps, group.project, { op: 'release', epicId: group.epicId })
  forgetArmedEpic(group.project, group.epicId)
  deps.log(`${tag(group.epicId, run.gen)} plan CHECKPOINT: +${added.length}/-${removed.length}; awaiting Jonas`)
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
  await io.appendBaton(deps, group.project, group.epicId, { kind: 'checkpoint', convId: 'broker', body })
  await io.sendEpicOp(deps, group.project, { op: 'release', epicId: group.epicId })
  // Stop sweeping it. A parked or complete run that stayed registered would be
  // beaten on every 45s forever, doing nothing, for the life of the broker.
  forgetArmedEpic(group.project, group.epicId)
  deps.log(`${tag(group.epicId, gen)} ${status}: ${body}`)
}

export interface ActionContext {
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
   * was being fetched and thrown away, so the check ran on "is any overseer
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
  'wake-overseer': (p, a: Extract<EpicAction, { kind: 'wake-overseer' }>) =>
    wakeOverseer(p.deps, p.group, p.run, a, p.ctx),
  plan: (p, a: Extract<EpicAction, { kind: 'plan' }>) => spawnPlanner(p.deps, p.group, p.run, a, p.ctx),
  'plan-accept': (p, a: Extract<EpicAction, { kind: 'plan-accept' }>) =>
    resolvePlanning(p.deps, p.group, p.run, a).then(() => null),
  'plan-checkpoint': (p, a: Extract<EpicAction, { kind: 'plan-checkpoint' }>) =>
    resolvePlanning(p.deps, p.group, p.run, a).then(() => null),
  dispatch: (p, a: Extract<EpicAction, { kind: 'dispatch' }>) =>
    spawnForCard(p.deps, p.group, p.run.gen, a.cardId, 'dispatch', a.dependsOn ?? []),
  verify: (p, a: Extract<EpicAction, { kind: 'verify' }>) =>
    spawnForCard(p.deps, p.group, p.run.gen, a.cardId, 'verify'),
  park: (p, a: Extract<EpicAction, { kind: 'park' }>) => settleRun(p.deps, p.group, p.run.gen, a).then(() => null),
  complete: (p, a: Extract<EpicAction, { kind: 'complete' }>) =>
    settleRun(p.deps, p.group, p.run.gen, a).then(() => null),
} as Record<EpicAction['kind'], Performer>

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
