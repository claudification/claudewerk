/**
 * SCHEDULE POLICY -- every "should this fire?" decision, as pure functions.
 *
 * Kept free of the store, the clock and `dispatchSpawn` so the rules that decide
 * whether a schedule fires can be tested exhaustively without a broker. The
 * engine (`engine.ts`) supplies `nowMs` and acts on the verdict; the fire path
 * (`fire.ts`) owns the side effects.
 *
 * The rule that matters most: a schedule fires at most once per WALL-CLOCK MINUTE
 * in its own zone, tracked by `lastFiredMinuteKey`. That single guard covers the
 * DST fall-back repeated hour, a broker restart inside the same minute, and a
 * tick that runs long enough to overlap the next one.
 */

import { nextFires } from '../../shared/cron-next'
import { matchesMinute, parseCron } from '../../shared/cron-parse'
import { minuteKey, wallClockParts } from '../../shared/cron-time'
import type { ScheduledTask } from '../../shared/scheduled-task'

/** Consecutive dispatch failures before a schedule disarms itself. */
export const MAX_CONSECUTIVE_FAILURES = 5
/** How stale a missed fire may be and still be worth catching up. */
const CATCH_UP_GRACE_MS = 6 * 60 * 60 * 1000
/** Ceiling on `missed` rows written for one outage -- history, not a stampede. */
const MAX_MISSED_ROWS = 20
/** Global ceiling on scheduler-originated spawns in flight at once. */
export const MAX_CONCURRENT_SCHEDULED_SPAWNS = 3

export type SkipReason =
  | 'disabled'
  | 'bad_cron'
  | 'not_started'
  | 'expired'
  | 'max_runs'
  | 'not_due'
  | 'already_fired'
  /** A one-shot whose moment passed while the broker was down, too stale to run late. */
  | 'one_shot_stale'

export type FireDecision = { fire: true; minuteKey: string } | { fire: false; reason: SkipReason }

/** The fire marker for a one-shot: its own instant, so it can only ever match once. */
export function oneShotKey(runAt: number): string {
  return `once:${runAt}`
}

/**
 * A one-shot fires the first tick at or after its moment.
 *
 * Late is usually RIGHT: "run at 15:00" with the broker down 15:00-15:04 should
 * still run at 15:05 -- that is what a one-time instruction means. But late has
 * a limit; waking a three-day-old task on Monday morning is a surprise, not a
 * service. Past the grace it records `missed` and disarms.
 */
function decideOneShot(task: ScheduledTask, runAt: number, nowMs: number): FireDecision {
  if (nowMs < runAt) return { fire: false, reason: 'not_due' }
  const key = oneShotKey(runAt)
  if (task.lastFiredMinuteKey === key) return { fire: false, reason: 'already_fired' }
  if (nowMs - runAt > CATCH_UP_GRACE_MS) return { fire: false, reason: 'one_shot_stale' }
  return { fire: true, minuteKey: key }
}

/**
 * Is this schedule due RIGHT NOW?
 *
 * Ordered cheapest-and-most-decisive first so the once-a-minute walk over every
 * schedule stays trivial: the overwhelming majority bail at `not_due`.
 */
export function decideFire(task: ScheduledTask, nowMs: number): FireDecision {
  if (!task.enabled) return { fire: false, reason: 'disabled' }

  if (task.startAt !== undefined && nowMs < task.startAt) return { fire: false, reason: 'not_started' }
  if (task.endAt !== undefined && nowMs > task.endAt) return { fire: false, reason: 'expired' }
  if (task.maxRuns !== undefined && task.runCount >= task.maxRuns) return { fire: false, reason: 'max_runs' }

  // ONE-SHOT: an instant, so none of the wall-clock/DST machinery applies.
  if (task.runAt !== undefined) return decideOneShot(task, task.runAt, nowMs)

  // A schedule with neither cron nor runAt cannot fire; treat it like a broken
  // cron (quiet, visible in the log) rather than crashing the tick.
  const cron = task.cron === undefined ? null : parseCron(task.cron)
  // A schedule whose cron stopped parsing (hand-edited DB, older writer) must go
  // quiet rather than fire on a guess.
  if (!cron?.ok) return { fire: false, reason: 'bad_cron' }

  const wall = wallClockParts(nowMs, task.tz)
  if (!matchesMinute(cron.fields, wall)) return { fire: false, reason: 'not_due' }

  const key = minuteKey(wall, task.tz)
  if (key === task.lastFiredMinuteKey) return { fire: false, reason: 'already_fired' }

  return { fire: true, minuteKey: key }
}

/**
 * Reasons that mean "this schedule will never fire again" -- worth disarming.
 *
 * `already_fired` is terminal for a ONE-SHOT (its single moment is spent) but
 * NOT for a cron, where it only means "not twice in this minute" -- so that case
 * is decided by `isTerminalFor`, not by membership here.
 */
const TERMINAL_SKIPS: ReadonlySet<SkipReason> = new Set<SkipReason>(['expired', 'max_runs', 'one_shot_stale'])

/** Terminal in context: knows a spent one-shot from a cron that already ran this minute. */
export function isTerminalFor(task: ScheduledTask, reason: SkipReason): boolean {
  if (task.runAt !== undefined && reason === 'already_fired') return true
  return TERMINAL_SKIPS.has(reason)
}

/**
 * Fires that SHOULD have happened between the last run and now -- the broker was
 * down, or the machine was asleep.
 *
 * Capped: a schedule that ran every 5 minutes through a three-day outage has
 * ~860 missed fires, and neither the history nor the reader benefits from all of
 * them. Returns oldest-first.
 */
export function computeMissedFires(task: ScheduledTask, nowMs: number, cap = MAX_MISSED_ROWS): number[] {
  // A one-shot has no recurrence to walk: it either still fires (handled by
  // `decideFire`, possibly late) or it is stale. Reconciliation writes its
  // `missed` row from the stale path, not from here.
  if (task.runAt !== undefined) return []
  const cron = task.cron === undefined ? null : parseCron(task.cron)
  if (!cron?.ok) return []
  // With no prior run there is no gap to reason about -- a fresh schedule has not
  // missed anything, it simply has not started.
  const since = task.lastRunAt
  if (since === undefined || since >= nowMs) return []

  // Ask for one extra so an over-cap outage is detectable by the caller.
  const fires = nextFires(cron.fields, task.tz, since, cap + 1)
  return fires.filter(ms => ms < nowMs).slice(0, cap)
}

/**
 * Should the most recent missed fire be run now?
 *
 * `catchUp: 'skip'` (the default) never re-runs: waking to a stampede of
 * overnight work is worse than a gap. `'once'` runs a SINGLE catch-up, and only
 * if the miss is recent enough to still be useful.
 */
export function shouldCatchUp(
  task: ScheduledTask,
  missed: number[],
  nowMs: number,
  graceMs = CATCH_UP_GRACE_MS,
): boolean {
  if (task.catchUp !== 'once' || missed.length === 0) return false
  const mostRecent = missed[missed.length - 1] as number
  return nowMs - mostRecent <= graceMs
}

export interface FailureState {
  consecutiveFailures: number
  /** True when this failure crosses the threshold and the schedule disarms. */
  disable: boolean
}

/** Backoff bookkeeping after a dispatch attempt. Success always resets the count. */
export function nextFailureState(previous: number, dispatchOk: boolean): FailureState {
  if (dispatchOk) return { consecutiveFailures: 0, disable: false }
  const consecutiveFailures = previous + 1
  return { consecutiveFailures, disable: consecutiveFailures >= MAX_CONSECUTIVE_FAILURES }
}
