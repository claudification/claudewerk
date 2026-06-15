/**
 * Tier 1 unit tests for `usage-poller` -- retry-after parsing, raw-response
 * window parsing, per-profile poll outcomes, batched-report shaping, and the
 * legacy-UsageUpdate adapter. (Token discovery is tested in `oauth-token.test.ts`.)
 *
 * All side effects (fetch, token read) go through DI seams so the tests stay
 * hermetic -- no real network, no real keychain.
 */
import { describe, expect, test } from 'bun:test'
import type { ProfileUsageSnapshot } from '../shared/protocol'
import {
  buildSentinelUsageReport,
  parseRetryAfter,
  parseUsageWindows,
  pollProfileUsage,
  type RawUsageResponse,
  snapshotToLegacyUsageUpdate,
  type UsageFetcher,
} from './usage-poller'

// ─── parseRetryAfter ───────────────────────────────────────────────

describe('parseRetryAfter', () => {
  const NOW = 1_700_000_000_000

  test('delta-seconds -> ms', () => {
    expect(parseRetryAfter('346', NOW)).toBe(346_000)
    expect(parseRetryAfter('  0 ', NOW)).toBe(0)
  })

  test('HTTP-date -> ms until that date (clamped at 0)', () => {
    const future = new Date(NOW + 120_000).toUTCString()
    expect(parseRetryAfter(future, NOW)).toBe(120_000)
    const past = new Date(NOW - 120_000).toUTCString()
    expect(parseRetryAfter(past, NOW)).toBe(0)
  })

  test('absent / unparseable -> undefined', () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined()
    expect(parseRetryAfter('soon-ish', NOW)).toBeUndefined()
  })
})

// ─── parseUsageWindows ─────────────────────────────────────────────

function makeRaw(overrides: Partial<RawUsageResponse> = {}): RawUsageResponse {
  return {
    five_hour: { utilization: 12, resets_at: '2026-05-21T15:00:00Z' },
    seven_day: { utilization: 47, resets_at: '2026-05-28T00:00:00Z' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: null,
    ...overrides,
  }
}

describe('parseUsageWindows', () => {
  test('happy path returns both required windows', () => {
    const out = parseUsageWindows(makeRaw())
    expect(out).not.toBeNull()
    expect(out?.fiveHour).toEqual({ usedPercent: 12, resetAt: '2026-05-21T15:00:00Z' })
    expect(out?.sevenDay).toEqual({ usedPercent: 47, resetAt: '2026-05-28T00:00:00Z' })
  })

  test('utilization: null is treated as 0% (post-reset)', () => {
    const out = parseUsageWindows(makeRaw({ five_hour: { utilization: null, resets_at: '2026-05-21T15:00:00Z' } }))
    expect(out?.fiveHour?.usedPercent).toBe(0)
  })

  test('extra_usage divides by 100 for currency fields', () => {
    const out = parseUsageWindows(
      makeRaw({
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, utilization: 0.247 },
      }),
    )
    expect(out?.extraUsage).toEqual({
      isEnabled: true,
      monthlyLimit: 50,
      usedCredits: 12.34,
      utilization: 0.247,
    })
  })

  test('per-model windows pass through when present', () => {
    const out = parseUsageWindows(
      makeRaw({
        seven_day_opus: { utilization: 80, resets_at: '2026-05-28T00:00:00Z' },
        seven_day_sonnet: { utilization: 30, resets_at: '2026-05-28T00:00:00Z' },
      }),
    )
    expect(out?.sevenDayOpus?.usedPercent).toBe(80)
    expect(out?.sevenDaySonnet?.usedPercent).toBe(30)
  })
})

// ─── pollProfileUsage ──────────────────────────────────────────────

const profile = { name: 'work', configDir: '/tmp/work' }
const FIXED_NOW = 1716240000000

describe('pollProfileUsage', () => {
  test('no token -> unauthed snapshot with no_token error', async () => {
    const snap = await pollProfileUsage(profile, {
      readToken: () => null,
      now: () => FIXED_NOW,
    })
    expect(snap).toEqual({
      profile: 'work',
      authed: false,
      polledAt: FIXED_NOW,
      error: { kind: 'no_token' },
    })
  })

  test('200 response yields a full snapshot', async () => {
    const fetcher: UsageFetcher = async () => ({ ok: true, data: makeRaw() })
    const snap = await pollProfileUsage(profile, {
      readToken: () => 'sk-token',
      fetcher,
      now: () => FIXED_NOW,
    })
    expect(snap.authed).toBe(true)
    expect(snap.error).toBeUndefined()
    expect(snap.fiveHour?.usedPercent).toBe(12)
    expect(snap.sevenDay?.usedPercent).toBe(47)
    expect(snap.polledAt).toBe(FIXED_NOW)
  })

  test('5xx response yields an authed snapshot with http error', async () => {
    const fetcher: UsageFetcher = async () => ({ ok: false, kind: 'http', status: 503, body: 'gateway' })
    const snap = await pollProfileUsage(profile, {
      readToken: () => 'sk-token',
      fetcher,
      now: () => FIXED_NOW,
    })
    expect(snap.authed).toBe(true)
    expect(snap.fiveHour).toBeUndefined()
    expect(snap.error).toEqual({ kind: 'http', status: 503, detail: 'gateway' })
  })

  test('429 threads retry-after (ms) onto the snapshot error for backoff', async () => {
    const fetcher: UsageFetcher = async () => ({
      ok: false,
      kind: 'http',
      status: 429,
      body: 'Rate limited. Please try again later.',
      retryAfterMs: 346_000,
    })
    const snap = await pollProfileUsage(profile, {
      readToken: () => 'sk-token',
      fetcher,
      now: () => FIXED_NOW,
    })
    expect(snap.authed).toBe(true)
    expect(snap.error?.kind).toBe('http')
    expect(snap.error?.status).toBe(429)
    expect(snap.error?.retryAfterMs).toBe(346_000)
  })

  test('network error yields an authed snapshot with network error', async () => {
    const fetcher: UsageFetcher = async () => ({ ok: false, kind: 'network', detail: 'ETIMEDOUT' })
    const snap = await pollProfileUsage(profile, {
      readToken: () => 'sk-token',
      fetcher,
      now: () => FIXED_NOW,
    })
    expect(snap.error).toEqual({ kind: 'network', detail: 'ETIMEDOUT' })
  })

  test('parse failure (missing required windows) yields parse error', async () => {
    const fetcher: UsageFetcher = async () => ({
      ok: true,
      // Intentionally cast: simulates an API shape regression.
      data: { extra_usage: null, seven_day_opus: null, seven_day_sonnet: null } as unknown as RawUsageResponse,
    })
    const snap = await pollProfileUsage(profile, {
      readToken: () => 'sk-token',
      fetcher,
      now: () => FIXED_NOW,
    })
    expect(snap.error?.kind).toBe('parse')
  })

  test('401 triggers one token re-read + retry; success yields full snapshot', async () => {
    const tokens = ['stale-token', 'fresh-token']
    let readCount = 0
    const readToken = () => tokens[Math.min(readCount++, 1)]
    const fetched: string[] = []
    const fetcher: UsageFetcher = async token => {
      fetched.push(token)
      if (token === 'stale-token') return { ok: false, kind: 'http', status: 401 }
      return { ok: true, data: makeRaw() }
    }
    const snap = await pollProfileUsage(profile, { readToken, fetcher, now: () => FIXED_NOW })
    expect(fetched).toEqual(['stale-token', 'fresh-token'])
    expect(snap.error).toBeUndefined()
    expect(snap.authed).toBe(true)
  })

  test('401 with no rotated token surfaces the 401 (does not retry forever)', async () => {
    const readToken = () => 'same-token'
    let calls = 0
    const fetcher: UsageFetcher = async () => {
      calls++
      return { ok: false, kind: 'http', status: 401 }
    }
    const snap = await pollProfileUsage(profile, { readToken, fetcher, now: () => FIXED_NOW })
    expect(calls).toBe(1) // no retry when re-read returned the same token
    expect(snap.error?.kind).toBe('http')
    expect(snap.error?.status).toBe(401)
  })

  test('usage polling uses disk discovery, NOT a profile-configured oauthToken', async () => {
    // setup-token long-lived tokens are inference-only (403 on /api/oauth/usage).
    // The poller must use the configDir `/login` token (keychain/.credentials.json),
    // so even with an oauthToken present it reads from disk.
    const fetched: string[] = []
    const fetcher: UsageFetcher = async token => {
      fetched.push(token)
      return { ok: true, data: makeRaw() }
    }
    const snap = await pollProfileUsage(
      { name: 'work', configDir: '/tmp/work' },
      { readToken: () => 'keychain-login-token', fetcher, now: () => FIXED_NOW },
    )
    expect(fetched).toEqual(['keychain-login-token'])
    expect(snap.authed).toBe(true)
  })
})

// ─── buildSentinelUsageReport ──────────────────────────────────────

describe('buildSentinelUsageReport', () => {
  test('emits all profiles sorted by name, polledAt set', () => {
    const snaps: ProfileUsageSnapshot[] = [
      { profile: 'work', authed: false, polledAt: 1, error: { kind: 'no_token' } },
      {
        profile: 'default',
        authed: true,
        polledAt: 1,
        fiveHour: { usedPercent: 10, resetAt: 'x' },
        sevenDay: { usedPercent: 20, resetAt: 'y' },
      },
      { profile: 'alt', authed: false, polledAt: 1, error: { kind: 'no_token' } },
    ]
    const report = buildSentinelUsageReport(snaps, 12345)
    expect(report.type).toBe('sentinel_usage_report')
    expect(report.polledAt).toBe(12345)
    expect(report.profiles.map(p => p.profile)).toEqual(['alt', 'default', 'work'])
  })

  test('does not mutate the input array', () => {
    const snaps: ProfileUsageSnapshot[] = [
      { profile: 'b', authed: false, polledAt: 1, error: { kind: 'no_token' } },
      { profile: 'a', authed: false, polledAt: 1, error: { kind: 'no_token' } },
    ]
    buildSentinelUsageReport(snaps, 0)
    expect(snaps.map(p => p.profile)).toEqual(['b', 'a'])
  })
})

// ─── snapshotToLegacyUsageUpdate ───────────────────────────────────

describe('snapshotToLegacyUsageUpdate', () => {
  test('builds a legacy UsageUpdate from a happy snapshot', () => {
    const snap: ProfileUsageSnapshot = {
      profile: 'default',
      authed: true,
      polledAt: 999,
      fiveHour: { usedPercent: 10, resetAt: 'x' },
      sevenDay: { usedPercent: 20, resetAt: 'y' },
      sevenDayOpus: { usedPercent: 5, resetAt: 'z' },
    }
    const out = snapshotToLegacyUsageUpdate(snap)
    expect(out?.type).toBe('usage_update')
    expect(out?.fiveHour.usedPercent).toBe(10)
    expect(out?.sevenDayOpus?.usedPercent).toBe(5)
  })

  test('returns null for unauthed snapshot', () => {
    const snap: ProfileUsageSnapshot = {
      profile: 'work',
      authed: false,
      polledAt: 1,
      error: { kind: 'no_token' },
    }
    expect(snapshotToLegacyUsageUpdate(snap)).toBeNull()
  })

  test('returns null for errored snapshot', () => {
    const snap: ProfileUsageSnapshot = {
      profile: 'work',
      authed: true,
      polledAt: 1,
      error: { kind: 'http', status: 500 },
    }
    expect(snapshotToLegacyUsageUpdate(snap)).toBeNull()
  })
})
