/**
 * auth-expiry -- how long a profile's LOGIN has left before `/login` is the
 * only way back.
 *
 * Claude Code shows this itself ("Your login expires in 2 days - run /login to
 * renew", notice key `oauth-expiry`), and the field it reads is right there in
 * the credential blob the sentinel's usage probe already parses:
 * `refreshTokenExpiresAt`. We were throwing it away. So the sentinel can warn
 * about a login that is about to die on ANY profile, including the idle ones
 * nobody has opened a terminal on -- which are exactly the ones that expire,
 * since a refresh token's life extends every time it is used.
 *
 * Ported from CC 2.1.238's own check, keeping both of its sanity rails:
 *
 *   1. NO RECORDED DEADLINE -> no opinion. Old blobs (and the legacy
 *      `~/.claude.json` format) carry no `refreshTokenExpiresAt`; silence is
 *      correct there, never "expires today".
 *   2. IMPOSSIBLE BLOB -> no opinion. If the ACCESS token outlives the REFRESH
 *      token by more than a slack window, the pair cannot both be real, so the
 *      blob is treated as unreadable rather than trusted.
 *
 * Where we deliberately DIVERGE from CC:
 *
 *   - CC's warning window is 3 days, sized for a human who will see the notice
 *     on their next launch. A sentinel-hosted fleet needs more runway: nobody
 *     is watching an idle profile, and the day it dies every spawn against it
 *     fails at once. Our horizon is a week.
 *   - CC returns nothing once the deadline has PASSED (it has already fallen
 *     into a hard auth error by then). We still report it, with `daysLeft: 0`,
 *     because a panel that says "login expired" next to a 401 explains the 401.
 *
 * Pure -- the clock is a parameter, and the input is two plain numbers rather
 * than a credential object, so this can live in `shared/` and all three tiers
 * run the SAME derivation: the sentinel to report it, the broker to decide
 * whether to notify, the control panel to render it. Credential READING stays
 * sentinel-side in `src/sentinel/oauth-token.ts` -- the broker never holds a
 * credential, and this module never reaches for one.
 */

export const DAY_MS = 86_400_000

/** Claude Code's own warning window, kept as the slack allowance in rail 2. */
export const CC_WARN_WINDOW_MS = 3 * DAY_MS

/** How far ahead the sentinel warns. Wider than CC's 3 days -- see the header. */
export const AUTH_EXPIRY_WARN_MS = 7 * DAY_MS

export interface AuthExpiry {
  /** ms epoch at which the refresh token dies. May be in the past. */
  expiresAt: number
  /** Whole days remaining, rounded UP so "19 hours" reads as 1 day (CC parity).
   *  Clamped at 0, which means expired or dying within the next 24 hours. */
  daysLeft: number
}

/** The two stored expiries a credential blob can carry, both epoch ms, both 0
 *  when the source records none. Structurally satisfied by the sentinel's
 *  `OAuthCredential` so it can be passed straight in. */
export interface StoredExpiries {
  /** Access token expiry -- hours. Used only for the sanity rail. */
  expiresAt: number
  /** Refresh token expiry -- the login's hard deadline. */
  refreshExpiresAt: number
}

/**
 * The login deadline recorded in a credential, or null when the blob has no
 * trustworthy opinion (rails 1 and 2 above).
 */
export function readAuthExpiry(cred: StoredExpiries | null | undefined, now: number): AuthExpiry | null {
  if (!cred) return null
  const deadline = cred.refreshExpiresAt
  if (!Number.isFinite(deadline) || deadline <= 0) return null
  // An access token cannot meaningfully outlive the refresh token that renews
  // it; if the blob claims otherwise, distrust the pair rather than warn on it.
  if (cred.expiresAt > deadline + CC_WARN_WINDOW_MS) return null
  return { expiresAt: deadline, daysLeft: Math.max(0, Math.ceil((deadline - now) / DAY_MS)) }
}

/** Derive the same shape from a deadline the sentinel already reported on the
 *  wire (`ProfileUsageSnapshot.authExpiresAt`), which has passed the rails
 *  above. For the broker + control panel, which never see a credential. */
export function authExpiryFromDeadline(expiresAt: number | undefined, now: number): AuthExpiry | null {
  if (!Number.isFinite(expiresAt) || !expiresAt || expiresAt <= 0) return null
  return { expiresAt, daysLeft: Math.max(0, Math.ceil((expiresAt - now) / DAY_MS)) }
}

/** True when a deadline is inside the warning horizon (expired counts). */
export function isExpiringSoon(expiry: AuthExpiry | null, now: number, horizonMs = AUTH_EXPIRY_WARN_MS): boolean {
  if (!expiry) return false
  return expiry.expiresAt - now <= horizonMs
}

/** Human phrasing shared by the sentinel log line and the broker's push body.
 *  Mirrors CC's own wording so the two surfaces read the same. */
export function describeAuthExpiry(expiry: AuthExpiry, now: number): string {
  if (expiry.expiresAt - now <= 0) return 'login has expired - run /login to renew'
  return `login expires in ${expiry.daysLeft} ${expiry.daysLeft === 1 ? 'day' : 'days'} - run /login to renew`
}
