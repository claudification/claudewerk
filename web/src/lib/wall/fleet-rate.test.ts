/**
 * P4's rate maths -- the three ways a tokens/min tile lies.
 *
 *  - it reports the bucket that is still filling, so the number ramps and resets
 *  - it reports 0 when it simply has no samples yet
 *  - it counts cache reads, which dwarf everything and turn a spend meter into a
 *    cache-hit meter
 */

import { describe, expect, it } from 'vitest'
import type { TokenSample } from '@/hooks/token-flow-store'
import { RATE_BUCKET_MS, RATE_BUCKETS, tokenRate } from './fleet-rate'

// A clean multiple of the bucket width, so `windowEdges` does not round the
// window's right edge past `now` and shift what "complete" means.
const NOW = 1_700_000_040_000

function sample(over: Partial<TokenSample> = {}): TokenSample {
  return {
    ts: NOW,
    sentinelId: 's1',
    profile: 'work',
    model: 'opus',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...over,
  }
}

describe('tokenRate', () => {
  it('is null, not zero, when the ring holds nothing', () => {
    expect(tokenRate([], NOW)).toEqual({ buckets: [], perMinute: null })
  })

  it('divides the last COMPLETE bucket down to a per-minute rate', () => {
    // One bucket back from `now`: complete, and the newest complete one.
    const at = NOW - RATE_BUCKET_MS
    const rate = tokenRate([sample({ ts: at, input: 600, output: 400 })], NOW)
    // 1000 tokens over a 2-minute bucket = 500/min.
    expect(rate.perMinute).toBe(500)
  })

  it('never reports the bucket that is still filling', () => {
    // A burst inside the current (incomplete) bucket must not become the rate --
    // it would climb for two minutes and then appear to collapse.
    const mid = NOW + 30_000
    const rate = tokenRate([sample({ ts: mid - 1_000, input: 90_000, output: 10_000 })], mid)
    expect(rate.perMinute).toBe(0)
    expect(rate.buckets.every(b => b.input + b.output === 0)).toBe(true)
  })

  it('counts input + output only -- cache reads are not spend', () => {
    const at = NOW - RATE_BUCKET_MS
    const rate = tokenRate([sample({ ts: at, input: 100, output: 100, cacheRead: 5_000_000 })], NOW)
    expect(rate.perMinute).toBe(100)
  })

  it('windows to a fixed number of complete buckets, oldest first', () => {
    const rate = tokenRate([sample({ ts: NOW - RATE_BUCKET_MS, output: 2 })], NOW)
    expect(rate.buckets).toHaveLength(RATE_BUCKETS)
    const starts = rate.buckets.map(b => b.bucketStart)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    expect(starts.at(-1)).toBe(NOW - RATE_BUCKET_MS)
  })

  it('keeps the same window mid-bucket, where the newest bucket is still filling', () => {
    // The ordinary case: `now` is 30s into a bucket. That bucket is dropped, so
    // the newest COMPLETE one is the previous boundary's.
    const mid = NOW + 30_000
    const rate = tokenRate([sample({ ts: NOW - RATE_BUCKET_MS, output: 600 })], mid)
    expect(rate.buckets).toHaveLength(RATE_BUCKETS)
    expect(rate.buckets.at(-1)?.bucketStart).toBe(NOW - RATE_BUCKET_MS)
    expect(rate.perMinute).toBe(300)
  })

  it('drops a sample that has scrolled out of the window instead of stacking it at the edge', () => {
    const old = NOW - (RATE_BUCKETS + 5) * RATE_BUCKET_MS
    const rate = tokenRate([sample({ ts: old, input: 999_999 })], NOW)
    expect(rate.buckets.reduce((n, b) => n + b.input + b.output, 0)).toBe(0)
    expect(rate.perMinute).toBe(0)
  })

  it('includes the seeded history -- the bucket width is the seed granularity', () => {
    const at = NOW - RATE_BUCKET_MS
    const rate = tokenRate([sample({ ts: at, input: 240, output: 0, synthetic: true })], NOW)
    expect(rate.perMinute).toBe(120)
  })
})
