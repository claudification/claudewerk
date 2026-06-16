/**
 * usage-merge -- fold inference-derived plan utilization into the per-profile
 * usage snapshots, per-window freshest-wins.
 *
 * WHY: `/api/oauth/usage` rate-limits per access token, so the sentinel's poll
 * for a busy/shared profile is ~constantly 429'd. But Anthropic returns the SAME
 * 5h/7d utilization on the `anthropic-ratelimit-unified-*` data that rides on
 * every inference turn -- CC surfaces it on each `rate_limit_event` as
 * `{ rateLimitType, utilization }`. The agent host forwards it; the broker folds
 * it here, attributed to the conversation's REAL resolved profile, so the bars
 * stay truthful without ever hitting the throttled endpoint.
 *
 * A `rate_limit_event` carries only the REPRESENTATIVE window (e.g. five_hour at
 * 95%), so inference readings arrive one window at a time. We keep the freshest
 * reading per window and overlay it onto the (possibly stale / 429'd) poll
 * snapshot -- poll fills the windows inference hasn't touched yet.
 *
 * Pure + dependency-free so the policy is unit-tested without the broker.
 */

import type { ProfileUsageSnapshot, UsageWindow } from '../../shared/protocol'

/** Beyond this a contributing reading is considered stale (drives the panel's
 *  "Nm old" badge). Inference readings are seconds old; poll carry-forward can
 *  be minutes-to-hours. Sized a little above the 3-min poll cycle. */
export const USAGE_FRESHNESS_MS = 15 * 60 * 1000

const WINDOW_KEYS = ['fiveHour', 'sevenDay', 'sevenDayOpus', 'sevenDaySonnet'] as const
export type UsageWindowKey = (typeof WINDOW_KEYS)[number]

/** CC's `rateLimitType` / representative-claim values -> our snapshot window
 *  keys. Unknown / overage types map to undefined (ignored). */
const RATE_LIMIT_TYPE_TO_WINDOW: Record<string, UsageWindowKey> = {
  five_hour: 'fiveHour',
  seven_day: 'sevenDay',
  seven_day_opus: 'sevenDayOpus',
  seven_day_sonnet: 'sevenDaySonnet',
}

export function rateLimitTypeToWindow(rateLimitType: string | undefined): UsageWindowKey | undefined {
  return rateLimitType ? RATE_LIMIT_TYPE_TO_WINDOW[rateLimitType] : undefined
}

/** A single inference-derived window reading plus when it was observed. */
export interface InferenceWindow {
  usedPercent: number
  resetAt: string
  observedAt: number
}

/** Per-profile inference readings: one entry per window, freshest kept. */
export type InferenceUsageEntry = Partial<Record<UsageWindowKey, InferenceWindow>>

/**
 * Fold a single inference reading into a profile's entry, keeping the freshest
 * reading per window. Mutates + returns the entry. Returns the entry unchanged
 * when the incoming reading is older than what we already have for that window.
 */
export function applyInferenceReading(
  entry: InferenceUsageEntry,
  windowKey: UsageWindowKey,
  reading: InferenceWindow,
): InferenceUsageEntry {
  const existing = entry[windowKey]
  if (existing && existing.observedAt >= reading.observedAt) return entry
  entry[windowKey] = reading
  return entry
}

/**
 * Merge a poll snapshot with inference readings for one profile, per-window
 * freshest-wins. Inference overrides a window when it is at least as fresh as
 * the poll snapshot (or the poll has no usable windows there); the poll fills
 * the rest. Returns the snapshot to broadcast / serve for this profile.
 *
 * - Both sources absent of windows -> returns the poll snapshot verbatim (so a
 *   genuine 429 / no-token error still surfaces honestly).
 */
/** Pick the value + timestamp for one window: inference when it's at least as
 *  fresh as the poll (or the poll lacks it), else the poll window, else none. */
function pickWindow(
  pollWin: UsageWindow | undefined,
  pollAt: number,
  infWin: InferenceWindow | undefined,
): { window: UsageWindow; at: number } | undefined {
  if (infWin && (!pollWin || infWin.observedAt >= pollAt)) {
    return { window: { usedPercent: infWin.usedPercent, resetAt: infWin.resetAt }, at: infWin.observedAt }
  }
  if (pollWin) return { window: pollWin, at: pollAt }
  return undefined
}

export function mergeProfileUsage(
  profile: string,
  poll: ProfileUsageSnapshot | undefined,
  inference: InferenceUsageEntry | undefined,
  now: number,
  freshnessMs: number = USAGE_FRESHNESS_MS,
): ProfileUsageSnapshot {
  const out: ProfileUsageSnapshot = { profile, authed: false, polledAt: 0 }
  const pollUsable = !!poll && !poll.error
  const pollAt = poll?.polledAt ?? 0
  let newest = 0
  let hasWindows = false

  for (const key of WINDOW_KEYS) {
    const pick = pickWindow(pollUsable ? poll?.[key] : undefined, pollAt, inference?.[key])
    if (!pick) continue
    out[key] = pick.window
    newest = Math.max(newest, pick.at)
    hasWindows = true
  }

  if (!hasWindows) return poll ?? { profile, authed: false, polledAt: now }

  out.authed = true
  out.polledAt = newest
  if (pollUsable && poll?.extraUsage) out.extraUsage = poll.extraUsage
  if (now - newest > freshnessMs) out.stale = true
  return out
}
