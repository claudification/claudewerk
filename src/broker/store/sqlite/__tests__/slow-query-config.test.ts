/**
 * A misconfigured threshold must never silently switch observability OFF --
 * that is the failure mode where you go looking for slow queries during an
 * incident and find an empty log because of a typo in an env var.
 */

import { describe, expect, test } from 'bun:test'
import { queryStatsIntervalMs, readThreshold, slowQueryThresholdMs } from '../slow-query-config'

describe('readThreshold', () => {
  test('reads a valid value', () => {
    expect(readThreshold({ X: '250' }, 'X', 50)).toBe(250)
  })

  test('falls back when unset or empty', () => {
    expect(readThreshold({}, 'X', 50)).toBe(50)
    expect(readThreshold({ X: '' }, 'X', 50)).toBe(50)
  })

  test('keeps the default on garbage rather than disabling logging', () => {
    expect(readThreshold({ X: 'fast' }, 'X', 50)).toBe(50)
    expect(readThreshold({ X: '-10' }, 'X', 50)).toBe(50)
  })

  test('an explicit 0 IS honoured -- that is the documented off switch', () => {
    expect(readThreshold({ X: '0' }, 'X', 50)).toBe(0)
  })

  test('truncates a fractional threshold to whole milliseconds', () => {
    expect(readThreshold({ X: '12.9' }, 'X', 50)).toBe(12)
  })
})

describe('defaults', () => {
  test('slow-query logging is ON by default at 50ms', () => {
    expect(slowQueryThresholdMs({})).toBe(50)
  })

  test('the periodic aggregate dump is OFF by default', () => {
    expect(queryStatsIntervalMs({})).toBe(0)
  })

  test('both read their documented env vars', () => {
    expect(slowQueryThresholdMs({ CLAUDWERK_SLOW_QUERY_MS: '200' })).toBe(200)
    expect(queryStatsIntervalMs({ CLAUDWERK_QUERY_STATS_INTERVAL_MS: '60000' })).toBe(60_000)
  })
})
