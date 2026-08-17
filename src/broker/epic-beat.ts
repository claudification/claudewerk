/**
 * ONE BEAT of an epic run -- the decision, with no side effects.
 *
 * Everything the engine does between "something settled" and "something was
 * spawned" happens here, as a pure function from (run, board plan, what is
 * alive) to a list of ACTIONS. The caller performs them. That split is what
 * makes the interesting failures testable: double wakes, the dry-generation
 * park, the generation ceiling, and the window gate are all decisions, and none
 * of them needs a broker, a sentinel or a spawn to exercise.
 *
 * WHY A WAKE IS STATE-BASED, NOT EVENT-BASED. The obvious design fires the
 * overseer from a "worker ended" event. That loses a settle whenever the
 * overseer is mid-turn, and double-fires whenever two workers end together.
 * Instead the beat asks a standing question -- "is there a settled card the
 * baton has not acknowledged?" -- so a missed sweep is repaired by the next one
 * and a duplicate is refused by the lease CAS. Self-healing beats bookkeeping.
 */

import type { EpicPlan } from '../shared/epic-ready'
import type { EpicRunSnapshot } from '../shared/protocol'

/** What the caller should do. Order in the array is the order to do it in. */
export type EpicAction =
  | { kind: 'wake-overseer'; expectGen: number; reason: string }
  | { kind: 'dispatch'; cardId: string }
  | { kind: 'verify'; cardId: string }
  | { kind: 'park'; reason: string }
  | { kind: 'complete' }

export interface EpicBeatInput {
  run: EpicRunSnapshot
  plan: EpicPlan
  /** Card ids with a live implementer or verifier right now. */
  inFlight: readonly string[]
  /** Is the lease holder's conversation still alive? */
  overseerAlive: boolean
  /** Cards that reached a terminal state with no `completion` entry in the baton.
   *  The standing question that drives the wake. */
  unacknowledged: readonly string[]
  /** Is the project's nightshift window open right now? Only consulted when the
   *  run's cadence is `window` -- `now` ignores the clock entirely. */
  windowOpen: boolean
}

export interface EpicBeat {
  actions: EpicAction[]
  /** One line for the broker log. Never empty -- a beat that did nothing still
   *  has to say why, or a stalled epic is unexplainable from logs alone. */
  note: string
}

const beat = (note: string, actions: EpicAction[] = []): EpicBeat => ({ actions, note })

/** Cadence gate. `now` runs whenever; `window` defers dispatch to the night. */
function dispatchAllowed(run: EpicRunSnapshot, windowOpen: boolean): boolean {
  return run.cadence === 'now' || windowOpen
}

/** Terminal run states do nothing at all. Checked first so an aborted run cannot
 *  be revived by a late settle arriving from a worker nobody killed in time. */
const INERT: readonly EpicRunSnapshot['status'][] = ['paused', 'complete', 'aborted']

export function planBeat(input: EpicBeatInput): EpicBeat {
  const { run, plan } = input

  if (INERT.includes(run.status)) return beat(`run is ${run.status}; nothing to do`)

  if (run.gen >= run.maxGens) {
    return beat(`generation ceiling reached (${run.gen}/${run.maxGens})`, [
      { kind: 'park', reason: `hit the generation ceiling of ${run.maxGens} -- the run is thrashing, not working` },
    ])
  }

  // An overseer mid-turn owns the epic. Do not dispatch underneath it: it may be
  // rewriting the very cards the plan was computed from.
  if (input.overseerAlive) return beat(`overseer alive at gen ${run.gen}; holding the beat`)

  // A settled card the baton has not seen is the ONE fact that must reach a
  // fresh overseer, and it outranks dispatching more work.
  if (input.unacknowledged.length > 0) {
    return beat(`${input.unacknowledged.length} unacknowledged settle(s): ${input.unacknowledged.join(', ')}`, [
      { kind: 'wake-overseer', expectGen: run.gen, reason: 'card-settled' },
    ])
  }

  // A question only the overseer can answer, and no overseer running.
  if (plan.questions.length > 0) {
    return beat(`${plan.questions.length} open question(s) for the overseer`, [
      { kind: 'wake-overseer', expectGen: run.gen, reason: 'started' },
    ])
  }

  const actions: EpicAction[] = plan.verify.map(c => ({ kind: 'verify' as const, cardId: c.slug }))

  if (!dispatchAllowed(run, input.windowOpen)) {
    return beat(`cadence=window and the window is closed; ${plan.dispatch.length} card(s) waiting`, actions)
  }

  actions.push(...plan.dispatch.map(c => ({ kind: 'dispatch' as const, cardId: c.slug })))

  if (actions.length > 0) {
    return beat(
      `dispatching ${plan.dispatch.length}, verifying ${plan.verify.length}` +
        (plan.heldBack.length > 0 ? ` (${plan.heldBack.length} held back by the concurrency ceiling)` : ''),
      actions,
    )
  }

  if (plan.complete) return beat('every child terminal', [{ kind: 'complete' }])

  if (input.inFlight.length > 0) return beat(`${input.inFlight.length} still in flight; waiting`)

  // Nothing to do and nothing running. The overseer gets ONE chance to replan
  // before the run parks -- most "stuck" epics are a board problem it can fix.
  if (run.dryGens >= 1) {
    return beat(`second consecutive dry generation: ${plan.idleReason ?? 'nothing dispatchable'}`, [
      { kind: 'park', reason: plan.idleReason ?? 'nothing dispatchable and replanning did not help' },
    ])
  }

  return beat(`nothing dispatchable (${plan.idleReason ?? 'unknown'}); waking the overseer to replan`, [
    { kind: 'wake-overseer', expectGen: run.gen, reason: 'started' },
  ])
}
