import { describe, expect, it } from 'bun:test'
import { isProbeUnmeasurable, resolveBalancedHeadrooms } from './usage-lean'
import {
  authFailedSnapshot as authFailed,
  goodSnapshot as good,
  NOW,
  noTokenSnapshot as noToken,
  rateLimitedSnapshot as rateLimited,
} from './usage-test-fixtures'

const STALE_AUTH = {
  staleMs: 10 * 60 * 1000,
  carryForwardStaleMs: 30 * 60 * 1000,
  authErrorCarryForwardMs: 6 * 60 * 60 * 1000,
}

describe('isProbeUnmeasurable', () => {
  it('is true for HTTP 401 / 429 (a token WAS presented but the meter is unreadable)', () => {
    expect(isProbeUnmeasurable(authFailed)).toBe(true) // 401
    expect(isProbeUnmeasurable(rateLimited)).toBe(true) // 429
  })
  it('is false for no_token / unauthed / network / parse / good / undefined', () => {
    expect(isProbeUnmeasurable(noToken)).toBe(false)
    expect(isProbeUnmeasurable({ ...authFailed, error: { kind: 'network', detail: 'offline' } })).toBe(false)
    expect(isProbeUnmeasurable({ ...authFailed, error: { kind: 'http', status: 500, detail: 'oops' } })).toBe(false)
    expect(isProbeUnmeasurable(good())).toBe(false)
    expect(isProbeUnmeasurable(undefined)).toBe(false)
  })
})

describe('resolveBalancedHeadrooms -- unmeasurable-profile lean', () => {
  // The crux: a profile whose probe is 401/429 with NO last-good (the shared
  // default login's perpetual state) used to resolve to undefined -> UNKNOWN ->
  // starved. It now leans OPTIMISTIC (recently-reset, 0% used) so the picker
  // prefers it (and wakes its token).
  it('substitutes an optimistic recently-reset reading for a 401-with-no-last-good profile', () => {
    const map = resolveBalancedHeadrooms(
      [{ name: 'default', latest: authFailed, lastGood: undefined }],
      NOW,
      STALE_AUTH,
    )
    const r = map.get('default')
    expect(r?.substituted).toBe(true)
    expect(r?.headroom?.fiveHourUsedPercent).toBe(0)
    expect(r?.headroom?.sevenDayUsedPercent).toBe(0)
    expect(r?.headroom?.stale).toBe(false)
  })

  it('also leans on a 429-with-no-last-good profile', () => {
    const r = resolveBalancedHeadrooms([{ name: 'default', latest: rateLimited }], NOW, STALE_AUTH).get('default')
    expect(r?.substituted).toBe(true)
    expect(r?.headroom?.fiveHourUsedPercent).toBe(0)
  })

  it('prefers a real reading (fresh or carried-forward) over the optimistic lean', () => {
    // Fresh latest -> measured, not substituted.
    const fresh = resolveBalancedHeadrooms(
      [{ name: 'default', latest: good({ fiveHour: { usedPercent: 40, resetAt: new Date(NOW).toISOString() } }) }],
      NOW,
      STALE_AUTH,
    ).get('default')
    expect(fresh?.substituted).toBe(false)
    expect(fresh?.headroom?.fiveHourUsedPercent).toBe(40)
    // 401 latest + recent last-good -> carry-forward wins (not the lean).
    const carried = resolveBalancedHeadrooms(
      [{ name: 'default', latest: authFailed, lastGood: good({ polledAt: NOW - 60 * 1000 }) }],
      NOW,
      STALE_AUTH,
    ).get('default')
    expect(carried?.substituted).toBe(false)
    expect(carried?.headroom?.fiveHourUsedPercent).toBe(1) // good() default
  })

  it('does NOT fabricate for an uncredentialed / network-dark profile (stays UNKNOWN)', () => {
    const noTok = resolveBalancedHeadrooms([{ name: 'default', latest: noToken }], NOW, STALE_AUTH).get('default')
    expect(noTok?.substituted).toBe(false)
    expect(noTok?.headroom).toBeUndefined()
    const netDark = resolveBalancedHeadrooms(
      [{ name: 'default', latest: { ...authFailed, error: { kind: 'network', detail: 'x' } } }],
      NOW,
      STALE_AUTH,
    ).get('default')
    expect(netDark?.headroom).toBeUndefined()
  })

  it('resolves a mixed pool: B measured, A leaned', () => {
    const map = resolveBalancedHeadrooms(
      [
        { name: 'default', latest: authFailed, lastGood: undefined }, // A: probe-dead
        {
          name: 'work',
          latest: good({ fiveHour: { usedPercent: 62, resetAt: new Date(NOW + 3_600_000).toISOString() } }),
        }, // B: healthy
      ],
      NOW,
      STALE_AUTH,
    )
    expect(map.get('default')?.substituted).toBe(true)
    expect(map.get('default')?.headroom?.fiveHourUsedPercent).toBe(0) // optimistic
    expect(map.get('work')?.substituted).toBe(false)
    expect(map.get('work')?.headroom?.fiveHourUsedPercent).toBe(62) // real
  })
})
