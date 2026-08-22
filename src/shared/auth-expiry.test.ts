import { describe, expect, it } from 'bun:test'
import {
  AUTH_EXPIRY_WARN_MS,
  authExpiryFromDeadline,
  CC_WARN_WINDOW_MS,
  DAY_MS,
  describeAuthExpiry,
  isExpiringSoon,
  readAuthExpiry,
} from './auth-expiry'

const NOW = 1_716_240_000_000
const HOUR = 3_600_000

/** A healthy credential: access token good for an hour, login good for `days`. */
const cred = (days: number, accessAheadMs = HOUR) => ({
  expiresAt: NOW + accessAheadMs,
  refreshExpiresAt: NOW + days * DAY_MS,
})

describe('readAuthExpiry', () => {
  it('reports the refresh-token deadline, rounding days UP', () => {
    // 19 hours left is still "1 day" to a human staring at a countdown.
    const out = readAuthExpiry({ expiresAt: NOW + HOUR, refreshExpiresAt: NOW + 19 * HOUR }, NOW)
    expect(out).toEqual({ expiresAt: NOW + 19 * HOUR, daysLeft: 1 })
  })

  it('reads a comfortable login as many days out', () => {
    expect(readAuthExpiry(cred(27), NOW)?.daysLeft).toBe(27)
  })

  it('rail 1: no recorded deadline -> no opinion, never "expires today"', () => {
    expect(readAuthExpiry({ expiresAt: NOW + HOUR, refreshExpiresAt: 0 }, NOW)).toBeNull()
    expect(readAuthExpiry({ expiresAt: NOW + HOUR, refreshExpiresAt: Number.NaN }, NOW)).toBeNull()
    expect(readAuthExpiry({ expiresAt: NOW + HOUR, refreshExpiresAt: -1 }, NOW)).toBeNull()
    expect(readAuthExpiry(null, NOW)).toBeNull()
    expect(readAuthExpiry(undefined, NOW)).toBeNull()
  })

  it('rail 2: an access token outliving the login by more than the slack is a bogus blob', () => {
    // Access token claims to outlive the refresh token by a year -> distrust.
    expect(readAuthExpiry({ expiresAt: NOW + 365 * DAY_MS, refreshExpiresAt: NOW + DAY_MS }, NOW)).toBeNull()
  })

  it('rail 2: slack inside the window is tolerated, not discarded', () => {
    const deadline = NOW + DAY_MS
    const within = { expiresAt: deadline + CC_WARN_WINDOW_MS - 1, refreshExpiresAt: deadline }
    expect(readAuthExpiry(within, NOW)?.daysLeft).toBe(1)
  })

  it('reports an ALREADY-EXPIRED login as 0 days rather than staying silent', () => {
    // Diverges from CC on purpose: "login expired" is what explains the 401
    // sitting next to it in the panel.
    const out = readAuthExpiry({ expiresAt: NOW - 10 * DAY_MS, refreshExpiresAt: NOW - 2 * DAY_MS }, NOW)
    expect(out).toEqual({ expiresAt: NOW - 2 * DAY_MS, daysLeft: 0 })
  })
})

describe('authExpiryFromDeadline', () => {
  it('derives the same shape from a wire timestamp', () => {
    expect(authExpiryFromDeadline(NOW + 3 * DAY_MS, NOW)).toEqual({ expiresAt: NOW + 3 * DAY_MS, daysLeft: 3 })
  })

  it('has no opinion on a missing or nonsense deadline', () => {
    expect(authExpiryFromDeadline(undefined, NOW)).toBeNull()
    expect(authExpiryFromDeadline(0, NOW)).toBeNull()
    expect(authExpiryFromDeadline(Number.NaN, NOW)).toBeNull()
  })
})

describe('isExpiringSoon', () => {
  it('is quiet outside the horizon and loud inside it', () => {
    expect(isExpiringSoon(readAuthExpiry(cred(27), NOW), NOW)).toBe(false)
    expect(isExpiringSoon(readAuthExpiry(cred(6), NOW), NOW)).toBe(true)
    expect(isExpiringSoon(null, NOW)).toBe(false)
  })

  it('counts an expired login as expiring', () => {
    const expired = { expiresAt: NOW - DAY_MS, daysLeft: 0 }
    expect(isExpiringSoon(expired, NOW)).toBe(true)
  })

  it('sits exactly on the horizon boundary rather than one tick past it', () => {
    const onEdge = { expiresAt: NOW + AUTH_EXPIRY_WARN_MS, daysLeft: 7 }
    expect(isExpiringSoon(onEdge, NOW)).toBe(true)
    expect(isExpiringSoon({ expiresAt: onEdge.expiresAt + 1, daysLeft: 8 }, NOW)).toBe(false)
  })

  it('is wider than the 3 days Claude Code warns at -- an idle fleet needs runway', () => {
    expect(AUTH_EXPIRY_WARN_MS).toBeGreaterThan(CC_WARN_WINDOW_MS)
    const fiveDays = readAuthExpiry(cred(5), NOW)
    expect(isExpiringSoon(fiveDays, NOW)).toBe(true)
    expect(isExpiringSoon(fiveDays, NOW, CC_WARN_WINDOW_MS)).toBe(false)
  })
})

describe('describeAuthExpiry', () => {
  it('singularises one day and pluralises the rest', () => {
    expect(describeAuthExpiry({ expiresAt: NOW + 19 * HOUR, daysLeft: 1 }, NOW)).toBe(
      'login expires in 1 day - run /login to renew',
    )
    expect(describeAuthExpiry({ expiresAt: NOW + 2 * DAY_MS, daysLeft: 2 }, NOW)).toBe(
      'login expires in 2 days - run /login to renew',
    )
  })

  it('speaks in the past tense once the deadline is behind us', () => {
    expect(describeAuthExpiry({ expiresAt: NOW - DAY_MS, daysLeft: 0 }, NOW)).toBe(
      'login has expired - run /login to renew',
    )
  })
})
