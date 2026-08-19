/**
 * THE WALL's plan-usage SERIES policy -- one module, both ends of the wire.
 *
 * The current utilization already exists. What did not exist is its SHAPE: "am I
 * about to get throttled, and which account first" is a question about the last
 * five hours, not about one number. That series is kept in exactly the same
 * structure on the broker (durable, the thing a cold wall is seeded from) and in
 * the browser (folded from frames), so the two cannot drift into disagreeing
 * about what a series IS.
 *
 * KEYED BY PROFILE **PLUS NODE**. The same profile name on two sentinels is two
 * accounts with two independent 5h buckets; collapsing them would draw one line
 * that is the truth of neither.
 *
 * MIN GAP, NOT A POLL. Samples arrive from two live sources at wildly different
 * rates: the sentinel's batched usage report (~3 min) and every conversation's
 * `rate_limit_event` (as fast as inference happens). Appending all of them would
 * put thousands of near-identical points on a chart 300 px wide. So a sample is
 * kept when it is far enough from the last one IN TIME, or when it actually SAYS
 * something different -- the number moved, or the profile changed state. A spike
 * from 40% to 95% inside ten seconds is never thinned away.
 *
 * Pure: every function takes `now`, nothing reads the clock, nothing allocates a
 * timer. The broker samples on the events it already receives and the client
 * folds on the frames it already gets; neither side polls for this.
 */

import type { WallPlanSample } from './wall'

/** The window the S2 chart draws. Samples older than this are dropped on every
 *  append -- a wall left open overnight holds five hours, not overnight. */
export const WALL_PLAN_WINDOW_MS = 5 * 60 * 60 * 1000

/** Closest two kept samples of one series may be when nothing changed. 5h at
 *  one-per-minute is 300 points per profile, which is more than a pane 300 px
 *  wide can draw and cheap enough that the cap is a backstop, not a policy. */
export const WALL_PLAN_MIN_GAP_MS = 60_000

/** A move of at least this many utilization points defeats the min gap. The
 *  numbers are integer percents, so this keeps every real step. */
const WALL_PLAN_MIN_DELTA_PCT = 1

/** Hard per-series bound. Window pruning normally gets there first; this is what
 *  holds if a producer ever ignores the min gap. */
const WALL_PLAN_SERIES_CAP = 320

/** How many distinct profile@node series are held at once. Beyond this the
 *  series that has not been written to for longest is dropped -- a bound that
 *  survives a fleet churning through sentinel aliases. */
const WALL_PLAN_KEY_CAP = 24

/** The line the pane draws dashed across the chart. Anthropic does not throttle
 *  at exactly this number; it is the "start caring" mark the epic asked for. */
export const WALL_PLAN_THROTTLE_PCT = 80

/** A series map, keyed by `wallPlanKey`, each value oldest-first. */
export type WallPlanSeries = Map<string, WallPlanSample[]>

/** Profile plus node. A bare profile (no node) is its own series, not a wildcard
 *  that merges into every node's. */
export function wallPlanKey(sample: { profile: string; node?: string }): string {
  return sample.node ? `${sample.profile}@${sample.node}` : sample.profile
}

export interface WallPlanAppendOptions {
  /** Minimum spacing between kept samples of one series. 0 keeps everything --
   *  what the CLIENT wants, because the broker already did the thinning. */
  minGapMs?: number
  windowMs?: number
  cap?: number
  keyCap?: number
}

/** Two samples say the same thing when the number and the state both agree.
 *  `stale` counts: a live 62% and a carried-forward 62% are different facts. */
function saysTheSame(a: WallPlanSample, b: WallPlanSample): boolean {
  return (
    a.state === b.state &&
    !!a.stale === !!b.stale &&
    a.resetsAt === b.resetsAt &&
    Math.abs(a.utilization - b.utilization) < WALL_PLAN_MIN_DELTA_PCT
  )
}

/** Drop everything older than the window, then anything over the cap. Mutates
 *  and returns the same array so a caller holding the map's value keeps it. */
function prune(series: WallPlanSample[], now: number, windowMs: number, cap: number): WallPlanSample[] {
  const cutoff = now - windowMs
  let first = 0
  while (first < series.length && (series[first] as WallPlanSample).at < cutoff) first++
  if (first > 0) series.splice(0, first)
  if (series.length > cap) series.splice(0, series.length - cap)
  return series
}

/** Evict the least-recently-written series once the map is over its key cap. */
function evictColdestKeys(all: WallPlanSeries, keyCap: number): void {
  if (all.size <= keyCap) return
  const byRecency = [...all.entries()].sort((a, b) => lastAt(a[1]) - lastAt(b[1]))
  for (let i = 0; i < all.size - keyCap; i++) {
    const entry = byRecency[i]
    if (entry) all.delete(entry[0])
  }
}

function lastAt(series: WallPlanSample[]): number {
  return series[series.length - 1]?.at ?? 0
}

/**
 * Append one sample to its series, applying the min gap, the window and both
 * caps. Returns true when the sample was KEPT -- the broker uses that to decide
 * whether the wall hub hears about it at all.
 *
 * A sample that arrives out of order (older than the newest one held) is
 * dropped. The series is a line drawn left to right; splicing a late reading
 * into its middle would redraw history under the reader.
 */
export function appendPlanSample(
  all: WallPlanSeries,
  sample: WallPlanSample,
  now: number,
  opts: WallPlanAppendOptions = {},
): boolean {
  const minGapMs = opts.minGapMs ?? WALL_PLAN_MIN_GAP_MS
  const windowMs = opts.windowMs ?? WALL_PLAN_WINDOW_MS
  const cap = opts.cap ?? WALL_PLAN_SERIES_CAP
  const keyCap = opts.keyCap ?? WALL_PLAN_KEY_CAP

  if (sample.at < now - windowMs) return false

  const key = wallPlanKey(sample)
  const series = all.get(key) ?? []
  const last = series[series.length - 1]

  if (last) {
    if (sample.at < last.at) return false
    if (sample.at - last.at < minGapMs && saysTheSame(last, sample)) return false
  }

  series.push(sample)
  prune(series, now, windowMs, cap)
  all.set(key, series)
  evictColdestKeys(all, keyCap)
  return true
}

/** Prune every series against `now` and drop the ones left empty. Called when
 *  something wants the picture but no sample has arrived to trigger a prune. */
export function prunePlanSeries(all: WallPlanSeries, now: number, opts: WallPlanAppendOptions = {}): void {
  const windowMs = opts.windowMs ?? WALL_PLAN_WINDOW_MS
  const cap = opts.cap ?? WALL_PLAN_SERIES_CAP
  for (const [key, series] of all) {
    if (prune(series, now, windowMs, cap).length === 0) all.delete(key)
  }
}

/** Every held sample, oldest first across all series. The wire carries a flat
 *  list; the key is recoverable from each sample, so nothing is lost. */
export function flattenPlanSeries(all: WallPlanSeries): WallPlanSample[] {
  const out: WallPlanSample[] = []
  for (const series of all.values()) out.push(...series)
  return out.sort((a, b) => a.at - b.at)
}

/** Fold a flat list (a frame's `plan` section, or a seed replay) into a series
 *  map. Returns the map for chaining. */
export function foldPlanSamples(
  all: WallPlanSeries,
  samples: readonly WallPlanSample[],
  now: number,
  opts: WallPlanAppendOptions = {},
): WallPlanSeries {
  for (const sample of samples) appendPlanSample(all, sample, now, opts)
  return all
}
