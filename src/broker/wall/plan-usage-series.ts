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
  WALL_PLAN_MIN_GAP_MS,
  WALL_PLAN_WINDOW_MS,
  type WallPlanSeries,
  wallPlanKey,
} from '../../shared/wall-plan-series'
import { readStatsByKind } from '../stats/read'
import { recordStat } from '../stats/store'
import { publishWallPlanSample } from './index'

/** The in-memory series. Module-scope for the same reason the hub is: one broker
 *  process, one history. Its durable tail is `stat_samples`. */
const series: WallPlanSeries = new Map()

/** Series key -> the timestamp of the newest sample restored into it at boot,
 *  until the first live sample lands. That first live sample is the one that has
 *  to declare the outage: see `gapBefore`. */
const restoredAt = new Map<string, number>()

/** Which sentinel a batch of profile snapshots came from. The ALIAS is what the
 *  wire and the series key use (it matches `WallPulseRow.host`); the ID is what
 *  the durable object is keyed on, because an alias is a label and a nodeId is
 *  identity. Both, or the two halves cannot be joined back up on boot. */
export interface WallPlanNode {
  id: string
  alias?: string
}

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
  node: WallPlanNode | undefined,
  at: number = Date.now(),
): WallPlanSample[] {
  const alias = node?.alias || node?.id
  const kept: WallPlanSample[] = []
  for (const snap of profiles) {
    const base = planSampleFrom(snap, alias, at)
    const sample = markGap(base, at)
    if (!appendPlanSample(series, sample, at)) continue
    restoredAt.delete(wallPlanKey(sample))
    kept.push(sample)
    recordPlanStat(sample, node)
    publishWallPlanSample(sample)
  }
  return kept
}

/**
 * Flag the first live sample of a rehydrated series when the outage was longer
 * than the series' own minimum spacing.
 *
 * Anything shorter than the min gap is a spacing the chart draws all day
 * anyway; anything longer is a hole, and a line drawn across it would read as
 * "nothing changed while the broker was down" -- which nobody knows. Marking it
 * is all the broker can do; drawing the break is the pane's half.
 */
function markGap(sample: WallPlanSample, at: number): WallPlanSample {
  const previous = restoredAt.get(wallPlanKey(sample))
  if (previous === undefined || at - previous <= WALL_PLAN_MIN_GAP_MS) return sample
  return { ...sample, gapBefore: true }
}

/**
 * File the durable half.
 *
 * ONLY `state === 'ok'` IS PERSISTED. A sample's `utilization` is 0 in every
 * other state -- unauthed, errored, no window came back -- and the wire type
 * says so outright. Storing that 0 would put a flat line at the bottom of a
 * month-long chart and call it a measurement. The non-ok states are facts about
 * NOW, re-established by the next live reading within minutes; they are not
 * history.
 *
 * Nothing is filed without a sentinel id: the object hangs off the node it
 * lives on, and there is no honest node to hang it on otherwise.
 */
function recordPlanStat(sample: WallPlanSample, node: WallPlanNode | undefined): void {
  if (sample.state !== 'ok' || !node?.id) return
  recordStat(
    { nodeId: node.id, kind: 'profile', name: sample.profile, ...(node.alias ? { label: node.alias } : {}) },
    'plan_utilization_percent',
    sample.utilization,
    sample.at,
  )
}

/**
 * Refill the series from the durable store. Called ONCE at boot, before the
 * first usage report arrives -- S2 draws the last FIVE HOURS, so a broker that
 * came back four minutes ago must still be able to show the four hours and
 * fifty-six minutes that preceded it.
 *
 * `minGapMs: 0`: these rows were already thinned on the way IN (only samples the
 * accumulator KEPT were ever recorded), so thinning them a second time would
 * drop real steps.
 *
 * A restored sample carries no `resetsAt`, `polledAt` or `stale` -- those are
 * properties of a live probe, not of a stored number, and inventing them would
 * be the lie. It does carry `state: 'ok'`, which is true by construction: only
 * ok samples are persisted.
 *
 * Returns the number of samples put back.
 */
export function rehydratePlanSeries(now: number = Date.now()): number {
  let restored = 0
  for (const stored of readStatsByKind('profile', 'plan_utilization_percent', now - WALL_PLAN_WINDOW_MS)) {
    const nodeLabel = stored.ref.label ?? stored.ref.nodeId
    for (const point of stored.points) {
      const sample: WallPlanSample = {
        profile: stored.ref.name,
        node: nodeLabel,
        utilization: point.value,
        at: point.ts,
        state: 'ok',
      }
      if (appendPlanSample(series, sample, now, { minGapMs: 0 })) restored++
    }
    const newest = stored.points[stored.points.length - 1]
    if (newest) restoredAt.set(wallPlanKey({ profile: stored.ref.name, node: nodeLabel }), newest.ts)
  }
  return restored
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
  restoredAt.clear()
}
