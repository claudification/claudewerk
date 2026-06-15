/**
 * usage-headroom -- map per-profile usage snapshots to the Smart Balance
 * picker's `UsageHeadroom` shape, with 429 CARRY-FORWARD.
 *
 * The problem this solves: `/api/oauth/usage` rate-limits per account. When the
 * usage PROBE for a profile gets throttled (HTTP 429), its latest snapshot is
 * an error with no windows. Collapsing that to "no telemetry" drops the profile
 * into the picker's UNKNOWN band, so a healthy account (e.g. 1% / 12%) loses
 * every balanced spawn to a sibling that happens to be under the 5h gate --
 * purely because we couldn't MEASURE it, which says nothing about its capacity.
 *
 * Fix: keep the last error-free snapshot per profile and fall back to it when
 * the latest poll has no usable windows. The carried-forward reading stays
 * usable for `carryForwardStaleMs` (sized to the max 429 backoff) so the
 * profile keeps ranking on real headroom for the whole throttle window. Past
 * that we genuinely haven't measured it in too long -> back to load-based
 * (UNKNOWN band), the same honest fallback used when the poller dies.
 *
 * Pure + dependency-free so the policy is unit-tested without booting the
 * sentinel (the live wiring in `index.ts` is a thin adapter over this).
 */

import type { ProfileUsageSnapshot } from '../shared/protocol'
import type { UsageHeadroom } from './selection'

/** A snapshot carries usable windows when it's authed, error-free, and has
 *  BOTH the 5h and 7d windows. Errored / unauthed / partial snapshots don't. */
export function snapshotHasWindows(
  snap: ProfileUsageSnapshot | undefined,
): snap is ProfileUsageSnapshot & Required<Pick<ProfileUsageSnapshot, 'fiveHour' | 'sevenDay'>> {
  return !!snap?.authed && !snap.error && !!snap.fiveHour && !!snap.sevenDay
}

/** Derive the picker headroom from a snapshot known to have windows. Staleness
 *  is measured from THAT snapshot's `polledAt` against the supplied window.
 *
 *  POST-RESET DECAY: a window whose `resetAt` has already passed has refreshed,
 *  so its utilisation is back to 0 -- regardless of what the (possibly carried-
 *  forward) snapshot recorded. Without this, a profile that was CAPPED when last
 *  measured (e.g. 5h=100%) and then went idle + auth-failed would stay wrongly
 *  GATED forever on the stale 100%, never getting the traffic that would refresh
 *  its token and let us measure it again. Decaying past the reset lets it return
 *  to the eligible band once its window genuinely refreshes -- the crux of the
 *  auth-error self-heal (see `deriveUsageHeadroom`). */
function headroomFromSnapshot(
  snap: ProfileUsageSnapshot & Required<Pick<ProfileUsageSnapshot, 'fiveHour' | 'sevenDay'>>,
  now: number,
  staleMs: number,
): UsageHeadroom {
  const fiveReset = new Date(snap.fiveHour.resetAt).getTime()
  const sevenReset = new Date(snap.sevenDay.resetAt).getTime()
  return {
    fiveHourUsedPercent: now > fiveReset ? 0 : snap.fiveHour.usedPercent,
    sevenDayUsedPercent: now > sevenReset ? 0 : snap.sevenDay.usedPercent,
    msUntilFiveHourReset: Math.max(0, fiveReset - now),
    msUntilSevenDayReset: Math.max(0, sevenReset - now),
    stale: now - snap.polledAt > staleMs,
  }
}

/** An HTTP 401 on the usage probe means the profile's OAuth token is expired /
 *  revoked -- we couldn't AUTHENTICATE, which says nothing about capacity. It is
 *  also self-reinforcing: an idle profile's token only refreshes when CC runs
 *  under it, and that traffic won't come if we demote the profile to UNKNOWN.
 *  So a 401 gets a far more generous carry-forward window than a 429 (whose
 *  backoff self-clears in minutes). */
function isAuthError(snap: ProfileUsageSnapshot | undefined): boolean {
  return snap?.error?.kind === 'http' && snap.error.status === 401
}

export interface HeadroomStaleness {
  /** Staleness window for the LATEST snapshot (a fresh poll is ~now, so this
   *  only bites when polling has silently stalled). */
  staleMs: number
  /** Staleness window for a CARRIED-FORWARD last-good snapshot. Sized to the
   *  max 429 backoff so a healthy profile keeps ranking on real headroom for
   *  the entire throttle window instead of blanking out partway through. */
  carryForwardStaleMs: number
  /** Carry-forward window when the LATEST poll failed with an AUTH error (401).
   *  Much longer than `carryForwardStaleMs`: a revoked/expired token won't self-
   *  heal in minutes (it needs traffic to refresh), so the profile must keep a
   *  ranking foothold long enough to win a spawn and re-auth. Combined with the
   *  post-reset decay above, a stale-but-carried reading self-corrects toward
   *  eligible rather than pinning a profile gated. Falls back to
   *  `carryForwardStaleMs` when unset. */
  authErrorCarryForwardMs?: number
}

/**
 * Map (latest, lastGood) snapshots to picker headroom with 429 carry-forward.
 *
 * - Latest has windows  -> use it (fresh-poll path, `staleMs`).
 * - Latest is errored/missing but lastGood has windows -> carry it forward
 *   (`carryForwardStaleMs`).
 * - Neither usable       -> `undefined` (UNKNOWN band -> load-based ranking).
 *
 * Staleness is always measured from the snapshot actually used.
 */
export function deriveUsageHeadroom(
  latest: ProfileUsageSnapshot | undefined,
  lastGood: ProfileUsageSnapshot | undefined,
  now: number,
  staleness: HeadroomStaleness,
): UsageHeadroom | undefined {
  if (snapshotHasWindows(latest)) return headroomFromSnapshot(latest, now, staleness.staleMs)
  if (snapshotHasWindows(lastGood)) {
    // A 401 on the latest poll gets the long auth-error window; everything else
    // (notably 429) uses the shorter throttle-sized window.
    const window = isAuthError(latest)
      ? (staleness.authErrorCarryForwardMs ?? staleness.carryForwardStaleMs)
      : staleness.carryForwardStaleMs
    return headroomFromSnapshot(lastGood, now, window)
  }
  return undefined
}
