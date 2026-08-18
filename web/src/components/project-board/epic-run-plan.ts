/**
 * What arming this epic actually commits you to, derived from the rollup you
 * already have.
 *
 * The RUN dialog used to ask for three settings and describe none of the thing
 * they applied to. You clicked RUN on an epic id and armed an unattended fleet
 * without being told whether that was two cards or forty, or how many of them
 * could even start. The numbers below are the ones that change the decision, so
 * they belong in front of it.
 *
 * Pure and rollup-only on purpose: no fetch, no engine round-trip. The board
 * already knows every card's bucket and its unfinished `depends_on` edges, which
 * is exactly what the first beat is computed from.
 */

import type { EpicRollup } from '@shared/epic-cards'
import type { StartEpicOptions } from '@/lib/epic-run-api'

export interface RunPlan {
  /** Live, with every dependency satisfied -- dispatchable in the first beat. */
  ready: number
  /** Live, but still waiting on a sibling. Unlocks as the run finishes those. */
  waiting: number
  /** Already terminal. The run walks past these. */
  done: number
  /** Archived: out of the run and out of the percentage. */
  dropped: number
  /** Everything the run has to get through: ready + waiting. */
  live: number
}

export function runPlan(rollup: EpicRollup): RunPlan {
  let ready = 0
  let waiting = 0
  for (const child of rollup.children) {
    if (child.bucket !== 'notStarted' && child.bucket !== 'inProgress') continue
    if (child.waitingOn.length > 0) waiting += 1
    else ready += 1
  }
  return { ready, waiting, done: rollup.done, dropped: rollup.dropped, live: ready + waiting }
}

/** How many implementers actually go out on beat 1. The number the concurrency
 *  stepper is really setting, which is not the same as the number you typed. */
export function firstBeat(plan: RunPlan, concurrency: number): number {
  return Math.min(plan.ready, Math.max(0, concurrency))
}

const CADENCE_CLAUSE: Record<StartEpicOptions['cadence'], string> = {
  now: 'Starts now',
  window: "Starts in the project's night window",
}

const TARGET_CLAUSE: Record<StartEpicOptions['target'], string> = {
  pr: 'stops at a green PR for you to read',
  merged: 'stops once each card is merged to main',
  shipped: 'does not stop until it is deployed',
}

/**
 * The three choices as one sentence. Three separate hints each describe their
 * own control; none of them says what the combination does, which is the only
 * thing being agreed to by pressing the button.
 */
export function consequence(options: StartEpicOptions): string {
  const each = options.concurrency === 1 ? 'one card at a time' : `${options.concurrency} at a time`
  return `${CADENCE_CLAUSE[options.cadence]}, ${each}, and ${TARGET_CLAUSE[options.target]}.`
}
