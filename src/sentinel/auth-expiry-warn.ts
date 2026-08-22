/**
 * auth-expiry-warn -- the sentinel's own "this login is about to die" notice.
 *
 * The usage poller already reads every profile's login deadline out of its
 * credential once per cycle (see `../shared/auth-expiry.ts`). This turns that
 * into a log line an operator will actually see, without repeating it on every
 * poll: a deadline moves once a week, so shouting about it every few minutes
 * would be noise that trains you to ignore the one cycle that matters.
 *
 * The dedupe key is the profile plus the number of days left, so the warning
 * re-prints exactly when the countdown TICKS (7 -> 6 -> 5 ...) and stays quiet
 * in between. A `/login` that pushes the deadline out drops the profile out of
 * the horizon entirely, which also clears its state -- so the next real
 * approach warns from scratch instead of being swallowed as a repeat.
 *
 * Pure state + a sink: no I/O of its own, so the tests need no fixtures.
 */

import { AUTH_EXPIRY_WARN_MS, type AuthExpiry, describeAuthExpiry, isExpiringSoon } from '../shared/auth-expiry'

/** Last `daysLeft` warned per profile. Module-level, mirroring the poller's
 *  other per-profile maps in `index.ts`. Exported for test reset only. */
const warnedDaysLeft = new Map<string, number>()

export function resetAuthExpiryWarnings(): void {
  warnedDaysLeft.clear()
}

export interface AuthExpiryWarning {
  profile: string
  daysLeft: number
  expiresAt: number
  /** Ready-to-log sentence, e.g. "profile `work` login expires in 2 days - run
   *  /login to renew". */
  message: string
}

/**
 * Decide whether this profile's deadline is worth saying out loud right now.
 *
 * Returns the warning to emit, or null when the login is comfortably alive OR
 * this exact countdown value has already been reported. Records what it
 * returns, so calling it once per profile per poll cycle is the intended use.
 */
export function takeAuthExpiryWarning(
  profile: string,
  expiry: AuthExpiry | null,
  now: number,
  horizonMs: number = AUTH_EXPIRY_WARN_MS,
): AuthExpiryWarning | null {
  if (!isExpiringSoon(expiry, now, horizonMs) || !expiry) {
    // Out of the horizon (or unknown) -- forget it, so a future approach warns.
    warnedDaysLeft.delete(profile)
    return null
  }
  if (warnedDaysLeft.get(profile) === expiry.daysLeft) return null
  warnedDaysLeft.set(profile, expiry.daysLeft)
  return {
    profile,
    daysLeft: expiry.daysLeft,
    expiresAt: expiry.expiresAt,
    message: `profile \`${profile}\` ${describeAuthExpiry(expiry, now)}`,
  }
}
