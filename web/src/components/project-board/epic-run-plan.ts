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
import type { EpicCadence } from '@shared/epic-run-types'
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

const WHEN_CLAUSE: Record<EpicCadence, string> = {
  now: 'Starts now',
  window: "Starts in the project's night window",
  queue: 'Waits until no other epic in this project is running, then takes the runner exclusively',
}

/**
 * The `when` axis as one clause, however many gates it carries.
 *
 * ALL of them must pass on the same beat, so they are joined with "and" rather
 * than listed: "starts in the night window AND waits until no other epic is
 * running" is a materially different promise from either half, and a sentence
 * that showed only the first gate would describe a run that does not exist.
 */
function whenClause(gates: readonly EpicCadence[]): string {
  const [first, ...rest] = gates.length > 0 ? gates : (['now'] as const)
  return [WHEN_CLAUSE[first], ...rest.map(g => lower(WHEN_CLAUSE[g]))].join(', and ')
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
  // "3 at a time" read as a promise of three. It is a CEILING: the engine
  // dispatches every ready card up to that number and holds the rest back, so
  // the real figure is min(ready, concurrency) and is usually lower.
  const each = options.concurrency === 1 ? 'one card at a time' : `up to ${options.concurrency} at a time`
  const sentence = `${whenClause(options.cadence)}, ${each}, and ${TARGET_CLAUSE[options.target]}.`
  // The planning generation comes BEFORE the cadence clause takes effect, so it
  // is a separate sentence rather than another clause in that one -- "starts
  // now" is not true of the first thing that happens when a plan is owed.
  return options.plan ? `Plans the epic first, then: ${lower(sentence)}` : sentence
}

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)
