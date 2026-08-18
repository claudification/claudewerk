/**
 * PERFORMING a beat's actions. `planBeat` decides, `epic-executor.ts` sequences,
 * and this file does the four things a beat can actually do: acknowledge a
 * settle, wake the overseer, dispatch or verify a card, and settle the run.
 *
 * Split out of the executor so that file stays the ORDER of a beat -- which is
 * its entire contract -- rather than the order plus four spawn recipes.
 */

import type { planEpic } from '../shared/epic-ready'
import type { EpicRunSnapshot } from '../shared/protocol'
import type { EpicAction, EpicBeat } from './epic-beat'
import { epicIo, tag } from './epic-io'
import { forgetArmedEpic } from './epic-registry'
import { type EpicSpawnCtx, planImplementerSpawn, planOverseerSpawn, planVerifierSpawn } from './epic-spawn-plan'
import type { EpicGroup } from './epic-sweep'
import type { BeatDeps } from './epic-types'

/**
 * Write a `completion` entry for every settled card the baton has not seen.
 *
 * Deliberately MACHINE-AUTHORED and terse: the implementer's own narrative went
 * into its card, and the point of this entry is to record that the card reached
 * a terminal state at all. An agent-authored summary here would be the one thing
 * the whole design says not to trust.
 */
export async function acknowledge(deps: BeatDeps, group: EpicGroup, pending: readonly string[]): Promise<void> {
  for (const cardId of pending) {
    const res = await epicIo().appendBaton(deps, group.project, group.epicId, {
      kind: 'completion',
      convId: 'broker',
      cardId,
      body: `Card \`${cardId}\` settled: every backing conversation has ended. Read the card for what it claims and its gate evidence for what it proved.`,
    })
    if (!res.ok) deps.log(`${tag(group.epicId, 0)} baton append FAILED for ${cardId}: ${res.error}`)
  }
}

function spawnCtx(group: EpicGroup, gen: number): EpicSpawnCtx {
  return { project: group.project, projectRoot: group.project, epicId: group.epicId, gen }
}

/** Take the lease, then spawn the overseer. A refused lease is NORMAL. */
async function wakeOverseer(
  deps: BeatDeps,
  group: EpicGroup,
  run: EpicRunSnapshot,
  action: Extract<EpicAction, { kind: 'wake-overseer' }>,
  ctx: ActionContext,
): Promise<string | null> {
  const io = epicIo()
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
  const spawn = planOverseerSpawn(spawnCtx(group, gen), {
    projectUri: group.project,
    projectRoot: group.project,
    run: { ...run, gen },
    plan: ctx.plan,
    batonTail: ctx.batonTail,
    wake: action.reason as never,
    settled: ctx.settled.map(c => `${c} settled`),
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
  const io = epicIo()
  const ctx = spawnCtx(group, gen)
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
  for (const action of beat.actions) {
    if (action.kind === 'wake-overseer') {
      const id = await wakeOverseer(deps, group, run, action, ctx)
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
