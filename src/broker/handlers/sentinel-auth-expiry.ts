/**
 * Profile login-expiry notices -- the FORWARD-LOOKING half of profile auth
 * health, sitting next to `notifyAuthTrouble` in `sentinel.ts`.
 *
 * Auth-trouble reacts to a probe that has ALREADY failed. This one fires while
 * the profile still works, off the `authExpiresAt` deadline the sentinel reads
 * out of the credential blob each cycle (the same field Claude Code's own
 * "Your login expires in N days" notice reads). The gap it closes is the idle
 * profile: a refresh token's life extends every time it is used, so the profile
 * nobody has opened a terminal on is the one that quietly dies -- and when it
 * does, every spawn against it fails at once with no warning.
 *
 * Two throttles, because a login deadline is a slow fact and a panel that cries
 * every poll cycle is a panel you stop reading:
 *
 *   1. A ONE-PER-DAY debounce per `sentinelId:profile`, so a week inside the
 *      horizon costs about seven notices, not two thousand.
 *   2. A deadline-CHANGE re-arm: when the stored deadline jumps (someone ran
 *      `/login`), the key is forgotten so the countdown starts clean rather
 *      than staying muted by the previous login's window.
 *
 * PROFILE-ENV BOUNDARY: names the profile and a generic recovery command only.
 */

import { AUTH_EXPIRY_WARN_MS, authExpiryFromDeadline, describeAuthExpiry } from '../../shared/auth-expiry'
import type { ProfileAuthExpiring, ProfileUsageSnapshot } from '../../shared/protocol'
import type { HandlerContext } from '../handler-context'
import { NotificationDebouncer } from '../notification-debounce'

/** One notice per profile per day. A deadline moves once a week; anything
 *  tighter is noise, anything looser can skip the final day entirely. */
export const AUTH_EXPIRY_NOTIFY_WINDOW_MS = 20 * 60 * 60_000

const authExpiryDebouncer = new NotificationDebouncer({ windowMs: AUTH_EXPIRY_NOTIFY_WINDOW_MS })

/** Last deadline seen per `sentinelId:profile`, so a re-login (deadline moves
 *  forward) re-arms the debounce instead of inheriting its silence. */
const lastSeenDeadline = new Map<string, number>()

export function resetAuthExpiryState(): void {
  authExpiryDebouncer.reset()
  lastSeenDeadline.clear()
}

/**
 * Detect + notify per-profile login expiry from the usage report the broker
 * already receives every cycle. Uses the report's `polledAt` as the clock so
 * the behaviour is deterministic and matches the cycle it was observed in.
 */
export function notifyAuthExpiring(ctx: HandlerContext, profiles: ProfileUsageSnapshot[], polledAt: number): void {
  const sentinelId = ctx.ws.data.sentinelId
  if (!sentinelId) return
  for (const snap of profiles) {
    const key = `${sentinelId}:${snap.profile}`
    const expiry = authExpiryFromDeadline(snap.authExpiresAt, polledAt)
    if (!expiry) {
      lastSeenDeadline.delete(key)
      continue
    }
    // A deadline that MOVED means the credential was renewed -- re-arm so the
    // next approach to the new deadline is announced on its own terms.
    if (lastSeenDeadline.get(key) !== expiry.expiresAt) {
      lastSeenDeadline.set(key, expiry.expiresAt)
      authExpiryDebouncer.reset(key)
    }
    if (expiry.expiresAt - polledAt > AUTH_EXPIRY_WARN_MS) continue
    if (!authExpiryDebouncer.shouldNotify(key, polledAt)) continue

    const recoveryHint = `Run: CLAUDE_CONFIG_DIR=<your ${snap.profile} profile dir> claude /login`
    ctx.broadcast({
      type: 'profile_auth_expiring',
      sentinelId,
      profile: snap.profile,
      expiresAt: expiry.expiresAt,
      daysLeft: expiry.daysLeft,
      polledAt,
      recoveryHint,
    } satisfies ProfileAuthExpiring)
    ctx.log.info(
      `[auth-expiry] sentinel=${sentinelId} profile=${snap.profile} daysLeft=${expiry.daysLeft} ` +
        `expiresAt=${new Date(expiry.expiresAt).toISOString()} -> notified`,
    )

    if (ctx.push.configured) {
      ctx.push.sendToAll({
        title: 'Login expiring',
        body: `Profile \`${snap.profile}\` ${describeAuthExpiry(expiry, polledAt)}`,
        tag: `auth-expiry-${key}`,
      })
    }
  }
}
