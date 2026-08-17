/**
 * THE EPIC EXECUTOR -- one beat, performed.
 *
 * `planBeat` decides; this performs. The split is why the interesting cases are
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
 * Every side effect goes through the injected `EpicIo` seam, for the reason
 * documented on NightshiftIo: Bun's `mock.module` is process-wide and leaks
 * doubles into every later test file in the run.
 */

import { renderEpicLogTail } from '../shared/epic-log'
import { planEpic } from '../shared/epic-ready'
import type { EpicRunSnapshot } from '../shared/protocol'
import type { SentinelRpcDeps } from './broker-sentinel-rpc'
import { type EpicAction, type EpicBeat, planBeat } from './epic-beat'
import { appendBaton, fetchBoardCards, fetchEpicRun, sendEpicOp } from './epic-broker-rpc'
import { type EpicSpawnCtx, planImplementerSpawn, planOverseerSpawn, planVerifierSpawn } from './epic-spawn-plan'
import { type EpicGroup, generationMismatch, unacknowledgedCards } from './epic-sweep'
import { dispatchSpawn } from './spawn-dispatch'

/** Effects, swappable. See the header for why this is not `mock.module`. */
export interface EpicIo {
  dispatchSpawn: typeof dispatchSpawn
  sendEpicOp: typeof sendEpicOp
  fetchEpicRun: typeof fetchEpicRun
  fetchBoardCards: typeof fetchBoardCards
  appendBaton: typeof appendBaton
}

const REAL_IO: EpicIo = { dispatchSpawn, sendEpicOp, fetchEpicRun, fetchBoardCards, appendBaton }
let io: EpicIo = REAL_IO

/**
 * Override some effects. CUMULATIVE -- it layers on whatever is configured now,
 * not on the real IO. The other spelling (`{...REAL_IO, ...next}`) reads
 * identically and silently un-stubs everything a previous call had replaced,
 * which cost a test that failed for a reason nowhere near the assertion.
 */
export function configureEpicIo(next: Partial<EpicIo>): void {
  io = { ...io, ...next }
}
export function resetEpicIo(): void {
  io = REAL_IO
}

export type LogFn = (line: string) => void

export interface BeatDeps extends SentinelRpcDeps {
  /** Everything `dispatchSpawn` needs, passed straight through. */
  spawnContext: Record<string, unknown>
  log: LogFn
  /** Is the project's night window open? ASYNC and consulted ONLY for
   *  cadence=window -- the answer lives in the project's nightshift config, and
   *  a `now` run must not pay a sentinel round trip to be told it does not care. */
  windowOpen: (project: string) => Promise<boolean>
  /** The conversation id to attribute the overseer's own baton entries to. */
  now: () => number
}

export interface BeatOutcome {
  epicId: string
  note: string
  actions: number
  spawned: string[]
  error?: string
}

/** Short form used in every log line, so one epic can be grepped end to end. */
const tag = (epicId: string, gen: number) => `[epic ${epicId} gen ${gen}]`

/**
 * Write a `completion` entry for every settled card the baton has not seen.
 *
 * Deliberately MACHINE-AUTHORED and terse: the implementer's own narrative went
 * into its card, and the point of this entry is to record that the card reached
 * a terminal state at all. An agent-authored summary here would be the one thing
 * the whole design says not to trust.
 */
async function acknowledge(deps: BeatDeps, group: EpicGroup, pending: readonly string[]): Promise<void> {
  for (const cardId of pending) {
    const res = await io.appendBaton(deps, group.project, group.epicId, {
      kind: 'completion',
      convId: 'broker',
      cardId,
      body: `Card \`${cardId}\` settled: every backing conversation has ended. Read the card for what it claims and its gate evidence for what it proved.`,
    })
    if (!res.ok) deps.log(`${tag(group.epicId, 0)} baton append FAILED for ${cardId}: ${res.error}`)
  }
}

/** Take the lease, then spawn the overseer. A refused lease is NORMAL. */
async function wakeOverseer(
  deps: BeatDeps,
  group: EpicGroup,
  run: EpicRunSnapshot,
  action: Extract<EpicAction, { kind: 'wake-overseer' }>,
  batonTail: string,
  plan: ReturnType<typeof planEpic>,
  settled: readonly string[],
): Promise<string | null> {
  const convId = `pending-${group.epicId}-${action.expectGen + 1}`
  const res = await io.sendEpicOp(deps, group.project, {
    op: 'lease',
    epicId: group.epicId,
    lease: { convId, expectGen: action.expectGen, holderAlive: group.overseerAlive },
  })
  if (!res.ok || !res.lease?.granted) {
    deps.log(`${tag(group.epicId, run.gen)} wake refused: ${res.lease?.reason ?? res.error ?? 'unknown'}`)
    return null
  }

  const gen = res.lease.gen
  const ctx: EpicSpawnCtx = {
    project: group.project,
    projectRoot: group.project,
    epicId: group.epicId,
    gen,
  }
  const spawn = planOverseerSpawn(ctx, {
    projectUri: group.project,
    projectRoot: group.project,
    run: { ...run, gen },
    plan,
    batonTail,
    wake: action.reason as never,
    settled: settled.map(c => `${c} settled`),
  })
  const out = await io.dispatchSpawn(spawn as never, deps.spawnContext as never)
  if (!out.ok) {
    deps.log(`${tag(group.epicId, gen)} overseer spawn FAILED: ${out.error}`)
    return null
  }
  deps.log(`${tag(group.epicId, gen)} overseer spawned: ${out.conversationId}`)
  return out.conversationId
}

/** Dispatch or verify one card. */
async function spawnForCard(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  cardId: string,
  role: 'dispatch' | 'verify',
): Promise<string | null> {
  const ctx: EpicSpawnCtx = { project: group.project, projectRoot: group.project, epicId: group.epicId, gen }
  const spawn = role === 'dispatch' ? planImplementerSpawn(ctx, cardId) : planVerifierSpawn(ctx, cardId)
  const out = await io.dispatchSpawn(spawn as never, deps.spawnContext as never)
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

/** Park or complete: patch the run and stop. Both are terminal for the sweep. */
async function settleRun(
  deps: BeatDeps,
  group: EpicGroup,
  gen: number,
  action: Extract<EpicAction, { kind: 'park' | 'complete' }>,
): Promise<void> {
  const status = action.kind === 'complete' ? 'complete' : 'paused'
  const body = action.kind === 'complete' ? 'Every child is terminal. Run complete.' : `Run PARKED: ${action.reason}`
  await io.sendEpicOp(deps, group.project, { op: 'patch', epicId: group.epicId, patch: { status } })
  await io.appendBaton(deps, group.project, group.epicId, { kind: 'checkpoint', convId: 'broker', body })
  await io.sendEpicOp(deps, group.project, { op: 'release', epicId: group.epicId })
  deps.log(`${tag(group.epicId, gen)} ${status}: ${body}`)
}

/**
 * Run ONE beat for one epic. Returns what it did, so the sweep can log a single
 * line per epic per tick rather than a scatter of unrelated messages.
 */
export async function runEpicBeat(deps: BeatDeps, group: EpicGroup): Promise<BeatOutcome> {
  const view = await io.fetchEpicRun(deps, group.project, group.epicId)
  if (!view.run) {
    return { epicId: group.epicId, note: 'no run artifact', actions: 0, spawned: [], error: view.error }
  }
  const run = view.run

  const mismatch = generationMismatch(group, run.gen)
  if (mismatch) deps.log(`${tag(group.epicId, run.gen)} ${mismatch}`)

  const pending = unacknowledgedCards(group.settled, view.baton)
  if (pending.length > 0) await acknowledge(deps, group, pending)

  const cards = await io.fetchBoardCards(deps, group.project)
  const plan = planEpic({
    cards,
    epicId: group.epicId,
    concurrency: run.concurrency,
    inFlight: group.inFlight,
  })

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
  })

  const spawned = await performActions(deps, group, run, beat, {
    batonTail: renderEpicLogTail(view.baton),
    plan,
    settled: pending,
  })

  deps.log(
    `${tag(group.epicId, run.gen)} beat: ${beat.note} (${beat.actions.length} action(s), ${spawned.length} spawned)`,
  )
  return { epicId: group.epicId, note: beat.note, actions: beat.actions.length, spawned }
}

interface ActionContext {
  batonTail: string
  plan: ReturnType<typeof planEpic>
  settled: readonly string[]
}

/**
 * Perform a beat's actions IN ORDER, collecting the conversations spawned.
 *
 * Sequential rather than concurrent on purpose: `dispatch` actions all consume
 * from the same capacity ledger, and firing them together would let the fleet
 * overshoot the concurrency ceiling by however many happened to be in the batch.
 */
async function performActions(
  deps: BeatDeps,
  group: EpicGroup,
  run: EpicRunSnapshot,
  beat: EpicBeat,
  ctx: ActionContext,
): Promise<string[]> {
  const spawned: string[] = []
  for (const action of beat.actions) {
    if (action.kind === 'wake-overseer') {
      const id = await wakeOverseer(deps, group, run, action, ctx.batonTail, ctx.plan, ctx.settled)
      if (id) spawned.push(id)
    } else if (action.kind === 'dispatch' || action.kind === 'verify') {
      const id = await spawnForCard(deps, group, run.gen, action.cardId, action.kind)
      if (id) spawned.push(id)
    } else {
      await settleRun(deps, group, run.gen, action)
    }
  }
  return spawned
}
