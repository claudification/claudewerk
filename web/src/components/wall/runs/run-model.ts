/**
 * A7's ARITHMETIC -- every judgement the pane makes, with no React, no fetch and
 * no clock of its own.
 *
 * NOTHING HERE RECOMPUTES THE ENGINE. The DAG lanes, the idle reason, the beat
 * ring and the lease all arrive already decided from `action=inspect`
 * (`epic-inspect-view.ts`); this file only counts what is in each lane and turns
 * three timestamps into the two sentences the pane exists to print. A second
 * implementation of "which lane is this card in" living on the client is exactly
 * how a pane starts disagreeing with the tool it claims to mirror.
 *
 * `nowMs` is a parameter everywhere for the same reason: the pane's freshness is
 * a real question (an inspect can be minutes old) and a function that reads
 * `Date.now()` for itself cannot be asked what it thought at any other moment.
 */

import { type EpicCapReading, epicRunCaps } from '@shared/epic-run-caps'
import { type RunVitalityView, runVitality } from '@shared/epic-vitality'
import type { NightshiftTaskMeta, NightshiftTaskStatus } from '@shared/nightshift-types'
import type { EpicActivityEntry, EpicInspectResult, EpicRunSnapshot } from '@shared/protocol'

/**
 * A run the sweep is supposed to be beating, and WHAT it is actually doing.
 *
 * The answer comes from `runVitality` (src/shared/epic-vitality.ts) rather than
 * from `entry.status`. The status field is an intent nothing writes back down,
 * so `status === 'running'` rendered this pane's tag as ARMED on a run that had
 * spawned nothing for hours -- the same lie the header badge and the overseer
 * window were telling at the same moment, which is why the derivation is shared.
 *
 * THERE WAS ALSO AN `isRunLive(entry)` HERE and it is gone on purpose. It said
 * nothing `runView(entry).live` does not, and a pane with two names for one
 * question is how the pane ended up with two answers to it. Row-level liveness
 * -- the one both feeds go through -- lives in `run-liveness.ts`.
 */
export function runView(entry: EpicActivityEntry): RunVitalityView {
  return runVitality(entry)
}

// ---------------------------------------------------------------------------
// THE DAG, AT A GLANCE
// ---------------------------------------------------------------------------

/** The six buckets the card names, in the order it names them. `inFlight` is the
 *  REGISTRY's count (conversations actually running) while the other five are the
 *  PLAN's lanes -- they answer different questions and must not be merged. */
export interface RunBuckets {
  ready: number
  inFlight: number
  verify: number
  held: number
  deps: number
  parked: number
}

export const NO_BUCKETS: RunBuckets = { ready: 0, inFlight: 0, verify: 0, held: 0, deps: 0, parked: 0 }

export function runBuckets(data: EpicInspectResult | null): RunBuckets {
  if (!data) return NO_BUCKETS
  const plan = data.plan
  return {
    ready: plan?.dispatch.length ?? 0,
    inFlight: data.live.inFlight.length,
    verify: plan?.verify.length ?? 0,
    held: plan?.heldBack.length ?? 0,
    deps: plan?.waitingOnDeps.length ?? 0,
    parked: plan?.questions.length ?? 0,
  }
}

/**
 * WHY NOTHING IS MOVING, or null when something is.
 *
 * The broker already writes the sentence; the only decision here is WHEN it is
 * worth printing. An idle reason on a paused run is not news -- it is paused --
 * and one on a run that just dispatched three cards would be stale by the time
 * it rendered. So: armed or running, and nothing ready to go.
 */
export function idleSentence(entry: EpicActivityEntry, data: EpicInspectResult | null): string | null {
  if (!data?.plan?.idleReason || !runView(entry).live) return null
  return data.plan.dispatch.length > 0 ? null : data.plan.idleReason
}

// ---------------------------------------------------------------------------
// THE HANDBRAKES -- how much budget the run has left
// ---------------------------------------------------------------------------

/**
 * The run's three ceilings and what is left of each, or an empty list when no
 * run artifact has been read yet.
 *
 * A THIN WRAPPER ON PURPOSE. The readings are computed in `@shared/epic-run-caps`,
 * beside the arithmetic the ENGINE parks on, so the pane cannot come to a
 * different view of "how much is left" than the beat that enforces it. Rendering
 * a run as healthy while the engine is about to park it for spend is precisely
 * the class of disagreement this pane was built to end.
 */
export function runCaps(run: EpicRunSnapshot | null, nowMs: number): EpicCapReading[] {
  if (!run) return []
  // THE GENERATION CAP IS ALREADY IN THE HEAD (`gen 28/60`), so printing
  // `generations 28/60` again three lines down is the same fact charged twice on
  // a pane whose whole complaint is length. It comes back the moment it is the
  // thing that STOPPED the run -- an alarm nobody sees is worse than a repeat.
  return epicRunCaps(run, nowMs).filter(cap => cap.label !== 'generations' || cap.over)
}

// ---------------------------------------------------------------------------
// STALLED -- the bug this pane exists to kill
// ---------------------------------------------------------------------------

export interface RunStall {
  /** Render this run as STALLED, loudly. */
  stalled: boolean
  /** Age of the last beat, or null when it has never beaten. */
  sinceMs: number | null
}

/**
 * STALLED is now `runVitality`'s call, so this pane, the header badge and the
 * overseer window cannot disagree about when a run stopped moving.
 *
 * ONE RULE CHANGED IN THE MOVE, deliberately. This used to call any live run
 * with no beat at all STALLED, to catch the 2026-08-18 shape -- an armed epic
 * the sweep never picked up. But the sweep runs every 45s, so that also shouted
 * STALLED at every healthy run for its first three quarters of a minute. The
 * shared rule splits the two: never beaten AND not in the armed set is stalled
 * (nothing will ever pick it up), never beaten while armed is ARMED (it is
 * waiting for a beat that is genuinely coming).
 *
 * `sinceMs` is still computed here because the banner prints the age.
 */
export function runStall(entry: EpicActivityEntry, nowMs: number): RunStall {
  const at = entry.lastBeatAt ? Date.parse(entry.lastBeatAt) : Number.NaN
  const sinceMs = Number.isFinite(at) ? Math.max(0, nowMs - at) : null
  return { stalled: runVitality(entry).vitality === 'stalled', sinceMs }
}

// THE OVERSEER LEASE moved to `@/lib/epic-lease-view` -- the overseer window
// needs the same sentence, and it could not import it from inside the wall.

// THE TAILS -- baton and beat pulse -- moved to `run-tails.ts`. Presenting a log
// and judging a run are different jobs, and this file was over the split bar.

// ---------------------------------------------------------------------------
// NIGHTSHIFT
// ---------------------------------------------------------------------------

const SETTLED = new Set<NightshiftTaskStatus>(['done', 'blocked', 'errored', 'skipped', 'integrated', 'discarded'])
const RUNNING = new Set<NightshiftTaskStatus>(['running', 'spinning'])

export interface NightshiftCounts {
  queued: number
  running: number
  settled: number
}

export function nightshiftCounts(tasks: readonly NightshiftTaskMeta[]): NightshiftCounts {
  const counts: NightshiftCounts = { queued: 0, running: 0, settled: 0 }
  for (const task of tasks) {
    if (task.status === 'queued') counts.queued++
    else if (RUNNING.has(task.status)) counts.running++
    else if (SETTLED.has(task.status)) counts.settled++
  }
  return counts
}
