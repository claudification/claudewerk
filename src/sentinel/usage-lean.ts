/**
 * usage-lean -- the unmeasurable-profile LEAN, layered over per-profile
 * `deriveUsageHeadroom` (in `usage-headroom.ts`) at the whole-pool level.
 *
 * The starvation deadlock this fixes: the SHARED default login's usage probe
 * (`/api/oauth/usage`) is chronically unusable -- 401 when its idle `/login`
 * token has expired, 429 when the per-account meter is rate-limited (it's polled
 * by the desktop app + every interactive `claude` + every spawn). So that
 * profile often has NO windows AND no last-good to carry forward, which drops it
 * into the picker's UNKNOWN band -- below every measurable sibling -- so it loses
 * EVERY balanced spawn. And a profile that never gets a spawn never runs CC, so
 * its token never refreshes and we never get to measure it: a self-reinforcing
 * starve. Per-profile `deriveUsageHeadroom` can't break this -- it can't see the
 * siblings and (rightly) refuses to fabricate a reading from a bare error.
 *
 * The fallback lives one level up, where we see the whole pool: a probe-
 * unmeasurable BUT credentialed profile is treated OPTIMISTICALLY -- assumed
 * freshly reset (0% used, full window ahead) -- so the picker LEANS toward it.
 * Rationale (Jonas): an account we can't read is most likely idle/recently
 * reset, and routing agents there is the single best way to "wake up" its auth
 * token (CC refreshes the token on spawn). Inference works without the usage
 * scope, so routing here is safe; the first poll that DOES succeed (woken by
 * that traffic) replaces the optimistic assumption with the real reading and
 * normal ranking resumes. Live-load damping (rankCandidate's LOAD term) still
 * keeps a burst from dog-piling a single woken profile.
 *
 * "Credentialed" = the probe got far enough to be rejected/throttled by the
 * server (HTTP 401/429), which means a token WAS sent. A `no_token` / unauthed /
 * network-errored profile is NOT substituted -- we have no evidence it can run.
 *
 * Pure + dependency-free so the policy is unit-tested without booting the
 * sentinel (the live wiring in `index.ts` is a thin adapter over this).
 */

import type { ProfileUsageSnapshot } from '../shared/protocol'
import type { UsageHeadroom } from './selection'
import { deriveUsageHeadroom, type HeadroomStaleness } from './usage-headroom'

const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000
const SEVEN_DAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Optimistic headroom for an unmeasurable-but-credentialed profile: assume it
 *  just reset (0% used, a full window until the next reset). Lands it at the top
 *  of the eligible band so the picker leans toward it -- see the file header. */
const RECENTLY_RESET_HEADROOM: UsageHeadroom = {
  fiveHourUsedPercent: 0,
  sevenDayUsedPercent: 0,
  msUntilFiveHourReset: FIVE_HOUR_WINDOW_MS,
  msUntilSevenDayReset: SEVEN_DAY_WINDOW_MS,
  stale: false,
}

/** True when the latest poll failed with an HTTP status that implies a token
 *  WAS presented (401 expired/revoked, 429 throttled) -- i.e. the profile is
 *  credentialed but its usage meter is unreadable. Network / no_token / parse
 *  errors don't qualify. */
export function isProbeUnmeasurable(snap: ProfileUsageSnapshot | undefined): boolean {
  return snap?.error?.kind === 'http' && (snap.error.status === 401 || snap.error.status === 429)
}

export interface ResolvedHeadroom {
  headroom: UsageHeadroom | undefined
  /** True when `headroom` was SUBSTITUTED (optimistic lean), not measured. For
   *  the LOG-EVERYTHING covenant -- the picker logs which profiles were leaned. */
  substituted: boolean
}

/**
 * Resolve picker headroom for a whole pool, applying the unmeasurable-profile
 * lean.
 *
 * Per profile: try `deriveUsageHeadroom` (fresh poll / carry-forward last-good).
 * If that yields nothing usable BUT the latest poll is probe-unmeasurable
 * (401/429 -- credentialed, meter just unreadable), substitute the optimistic
 * `RECENTLY_RESET_HEADROOM` so the picker leans toward it (wakes its token).
 * A genuinely uncredentialed / network-dark profile stays `undefined` and falls
 * through to live-load (legacy least-active), unchanged.
 */
export function resolveBalancedHeadrooms(
  entries: { name: string; latest?: ProfileUsageSnapshot; lastGood?: ProfileUsageSnapshot }[],
  now: number,
  staleness: HeadroomStaleness,
): Map<string, ResolvedHeadroom> {
  const out = new Map<string, ResolvedHeadroom>()
  for (const e of entries) {
    const measured = deriveUsageHeadroom(e.latest, e.lastGood, now, staleness)
    if (measured) {
      out.set(e.name, { headroom: measured, substituted: false })
    } else if (isProbeUnmeasurable(e.latest)) {
      out.set(e.name, { headroom: RECENTLY_RESET_HEADROOM, substituted: true })
    } else {
      out.set(e.name, { headroom: undefined, substituted: false })
    }
  }
  return out
}
