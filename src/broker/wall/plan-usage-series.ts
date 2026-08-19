/**
 * THE WALL's plan-usage producer: the SERIES behind S2.
 *
 * NO NEW SOURCE. The per-profile snapshot is already in the broker and already
 * richer than the wall needs -- `ProfileUsageSnapshot`, written by the batched
 * `sentinel_usage_report` and folded per-window from every conversation's
 * `rate_limit_event`. Both paths end in ONE merged broadcast, and this module
 * hangs off that broadcast. There is no poll here, no timer, and no second
 * utilization path: if the number changes, a sample appears; if nothing
 * changes, nothing happens.
 *
 * WHY THIS ONE ACCUMULATES WHILE UNWATCHED. Everything else on the wall obeys
 * "zero work when nobody is watching" and drops its picture when the last
 * subscriber leaves. The series cannot: a chart of the LAST FIVE HOURS that only
 * starts recording when someone opens the wall would be blank at exactly the
 * moment it is opened, and the pane would have to interpolate between two reads
 * to look like it worked. So the series is kept whether or not anyone is
 * watching -- and it is the cheapest thing on the wall to keep: at most a
 * few hundred five-field objects per profile, appended only when a reading the
 * broker already received says something new. The `publishWallPlanSample` call
 * beside it is still gated, so an unwatched broker builds no frames.
 *
 * PROFILE-ENV BOUNDARY. A sample carries the profile NAME and numbers. Nothing
 * here reads, copies or infers a config dir, a token or an env.
 */

import type { ProfileUsageSnapshot } from '../../shared/protocol'
import type { WallPlanSample, WallPlanState } from '../../shared/wall'
import {
  appendPlanSample,
  flattenPlanSeries,
  prunePlanSeries,
  type WallPlanSeries,
} from '../../shared/wall-plan-series'
import { publishWallPlanSample } from './index'

/** The durable series. Module-scope for the same reason the hub is: one broker
 *  process, one history. */
const series: WallPlanSeries = new Map()

/** `UsageWindow.resetAt` is an ISO string; the wire wants epoch ms. An
 *  unparseable one is dropped rather than turned into NaN or 1970. */
function resetsAtMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * What state is this profile in, for the FIVE-HOUR window specifically?
 *
 * The order matters: an error outranks a missing window (the window is missing
 * BECAUSE of the error), and not-authed outranks both (there was never anything
 * to fetch). `unknown` is the honest leftover -- authed, no error, and still no
 * 5h window came back.
 */
function stateOf(snap: ProfileUsageSnapshot): WallPlanState {
  if (snap.error) return 'error'
  if (!snap.authed) return 'unauthed'
  if (!snap.fiveHour) return 'unknown'
  return 'ok'
}

/** Project one merged snapshot onto the wall's sample shape. */
export function planSampleFrom(snap: ProfileUsageSnapshot, node: string | undefined, at: number): WallPlanSample {
  const state = stateOf(snap)
  const fiveHour = state === 'ok' ? snap.fiveHour : undefined
  const resetsAt = resetsAtMs(fiveHour?.resetAt)
  return {
    profile: snap.profile,
    ...(node ? { node } : {}),
    utilization: fiveHour ? Math.max(0, Math.min(100, fiveHour.usedPercent)) : 0,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    at,
    state,
    ...(snap.stale ? { stale: true } : {}),
    ...(snap.polledAt ? { polledAt: snap.polledAt } : {}),
    ...(snap.error?.kind ? { errorKind: snap.error.kind } : {}),
  }
}

/**
 * Sample one sentinel's merged per-profile usage into the series, and push what
 * was KEPT onto the wall. Returns the samples that were appended, so the caller
 * (and the tests) can see the thinning decision rather than guess at it.
 *
 * `node` is the sentinel ALIAS, matching `WallPulseRow.host` -- the wall's
 * `&host` filter axis is one vocabulary, not two.
 */
export function samplePlanUsage(
  profiles: readonly ProfileUsageSnapshot[],
  node: string | undefined,
  at: number = Date.now(),
): WallPlanSample[] {
  const kept: WallPlanSample[] = []
  for (const snap of profiles) {
    const sample = planSampleFrom(snap, node, at)
    if (!appendPlanSample(series, sample, at)) continue
    kept.push(sample)
    publishWallPlanSample(sample)
  }
  return kept
}

/** The whole held series, oldest first -- what a wall opened cold is seeded
 *  with. Prunes first: a series for a sentinel that went quiet an hour ago is
 *  only pruned when something writes to it, and nothing has. */
export function readPlanSeries(now: number = Date.now()): WallPlanSample[] {
  prunePlanSeries(series, now)
  return flattenPlanSeries(series)
}

/** Test isolation. The broker never calls this. */
export function resetPlanSeries(): void {
  series.clear()
}
