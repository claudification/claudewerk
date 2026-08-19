/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { bucketize, type TokenSample } from './token-flow-store'

function sample(overrides: Partial<TokenSample> = {}): TokenSample {
  return {
    ts: 0,
    sentinelId: 'snt_a',
    profile: 'work',
    model: 'opus',
    input: 10,
    output: 20,
    cacheRead: 500,
    cacheWrite: 5,
    ...overrides,
  }
}

describe('bucketize', () => {
  it('produces a dense series (zeros for idle buckets) across [from, to)', () => {
    const buckets = bucketize([sample({ ts: 0, output: 20 }), sample({ ts: 25_000, output: 30 })], 0, 30_000, 5_000)
    expect(buckets).toHaveLength(6) // 30s / 5s
    expect(buckets[0].output).toBe(20)
    expect(buckets[1].output).toBe(0) // idle bucket present as zero
    expect(buckets[5].output).toBe(30)
    expect(buckets.map(b => b.bucketStart)).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000])
  })

  it('sums multiple samples landing in the same bucket', () => {
    const buckets = bucketize([sample({ ts: 1_000, input: 10 }), sample({ ts: 4_000, input: 15 })], 0, 5_000, 5_000)
    expect(buckets).toHaveLength(1)
    expect(buckets[0].input).toBe(25)
  })

  it('excludes samples outside [from, to)', () => {
    const buckets = bucketize(
      [sample({ ts: -1, output: 99 }), sample({ ts: 10_000, output: 99 }), sample({ ts: 5_000, output: 7 })],
      0,
      10_000,
      5_000,
    )
    const total = buckets.reduce((s, b) => s + b.output, 0)
    expect(total).toBe(7) // ts=-1 (before from) and ts=10_000 (== to, exclusive) dropped
  })

  it('match filters to one (sentinelId, profile) series', () => {
    const buckets = bucketize(
      [
        sample({ ts: 0, profile: 'work', output: 10 }),
        sample({ ts: 0, profile: 'personal', output: 20 }),
        sample({ ts: 0, sentinelId: 'snt_b', profile: 'work', output: 40 }),
      ],
      0,
      5_000,
      5_000,
      { match: { sentinelId: 'snt_a', profile: 'work' } },
    )
    expect(buckets[0].output).toBe(10)
  })

  it('excludes synthetic samples by default', () => {
    const buckets = bucketize(
      [sample({ ts: 1_000, output: 50, synthetic: true }), sample({ ts: 2_000, output: 7 })],
      0,
      5_000,
      5_000,
    )
    expect(buckets[0].output).toBe(7)
  })

  it('includes synthetic samples when opts.includeSynthetic = true', () => {
    const buckets = bucketize(
      [sample({ ts: 1_000, output: 50, synthetic: true }), sample({ ts: 2_000, output: 7 })],
      0,
      5_000,
      5_000,
      { includeSynthetic: true },
    )
    expect(buckets[0].output).toBe(57)
  })
})
