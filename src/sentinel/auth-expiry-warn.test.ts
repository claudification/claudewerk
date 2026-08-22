import { beforeEach, describe, expect, it } from 'bun:test'
import { authExpiryFromDeadline, CC_WARN_WINDOW_MS, DAY_MS } from '../shared/auth-expiry'
import { resetAuthExpiryWarnings, takeAuthExpiryWarning } from './auth-expiry-warn'

const NOW = 1_716_240_000_000
const inDays = (d: number) => authExpiryFromDeadline(NOW + d * DAY_MS, NOW)

describe('takeAuthExpiryWarning', () => {
  beforeEach(resetAuthExpiryWarnings)

  it('says nothing about a login that is comfortably alive', () => {
    expect(takeAuthExpiryWarning('work', inDays(27), NOW)).toBeNull()
  })

  it('says nothing when the deadline is unknown', () => {
    expect(takeAuthExpiryWarning('work', null, NOW)).toBeNull()
  })

  it('warns once when the login enters the horizon, then stays quiet on repeat polls', () => {
    const first = takeAuthExpiryWarning('work', inDays(5), NOW)
    expect(first).toMatchObject({ profile: 'work', daysLeft: 5 })
    expect(first?.message).toBe('profile `work` login expires in 5 days - run /login to renew')

    // Same countdown value, three more poll cycles a few minutes apart.
    expect(takeAuthExpiryWarning('work', inDays(5), NOW + 60_000)).toBeNull()
    expect(takeAuthExpiryWarning('work', inDays(5), NOW + 120_000)).toBeNull()
    expect(takeAuthExpiryWarning('work', inDays(5), NOW + 180_000)).toBeNull()
  })

  it('speaks again on every countdown TICK', () => {
    expect(takeAuthExpiryWarning('work', inDays(3), NOW)?.daysLeft).toBe(3)
    expect(takeAuthExpiryWarning('work', inDays(3), NOW)).toBeNull()
    expect(takeAuthExpiryWarning('work', inDays(2), NOW)?.daysLeft).toBe(2)
    expect(takeAuthExpiryWarning('work', inDays(1), NOW)?.daysLeft).toBe(1)
  })

  it('tracks profiles independently', () => {
    expect(takeAuthExpiryWarning('work', inDays(2), NOW)).not.toBeNull()
    // A different profile at the same countdown is its own story.
    expect(takeAuthExpiryWarning('home', inDays(2), NOW)).not.toBeNull()
    expect(takeAuthExpiryWarning('work', inDays(2), NOW)).toBeNull()
  })

  it('re-arms after a /login pushes the deadline back out of the horizon', () => {
    expect(takeAuthExpiryWarning('work', inDays(2), NOW)).not.toBeNull()
    // Renewed -- far future, so nothing to say AND the memory of "2" is dropped.
    expect(takeAuthExpiryWarning('work', inDays(60), NOW)).toBeNull()
    // Weeks later it approaches 2 days again; that must be announced afresh.
    expect(takeAuthExpiryWarning('work', inDays(2), NOW)?.daysLeft).toBe(2)
  })

  it('warns about a login that has already lapsed', () => {
    const warning = takeAuthExpiryWarning('work', authExpiryFromDeadline(NOW - DAY_MS, NOW), NOW)
    expect(warning?.daysLeft).toBe(0)
    expect(warning?.message).toBe('profile `work` login has expired - run /login to renew')
  })

  it('honours a caller-supplied horizon', () => {
    // 5 days is inside our default week but outside CC's 3-day window.
    expect(takeAuthExpiryWarning('work', inDays(5), NOW, CC_WARN_WINDOW_MS)).toBeNull()
    expect(takeAuthExpiryWarning('work', inDays(2), NOW, CC_WARN_WINDOW_MS)).not.toBeNull()
  })
})
