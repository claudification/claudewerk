/**
 * Retention. "Per-object-per-metric-per-second forever" is the failure mode a
 * narrow table invites, so the bound is exercised here rather than asserted in
 * prose: old rows COLLAPSE to 5-minute buckets, very old rows go, and running
 * the sweep twice changes nothing.
 *
 * The collapse is NOT one aggregate. A gauge averages and a flow sums, so the
 * last describe puts one of each inside a single bucket and sweeps once -- the
 * ~28x under-report that averaging a `_count` produces is a silent, and after
 * the sweep's DELETE an unrecoverable, wrong number.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StatMetric, StatObjectRef } from '../../shared/stats'
import { STAT_FLOW_SUFFIX } from '../../shared/stats'
import { readStatsByKind } from './read'
import { STAT_BUCKET_MS, STAT_RAW_MS, STAT_RETENTION_MS, sweepStats } from './retention'
import { closeStatsStore, flushStats, initStatsStore, recordStat } from './store'

const NOW = Date.now()
const HOUR = 60 * 60 * 1000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stats-retention-test-'))
  initStatsStore(dir)
})
afterEach(() => {
  closeStatsStore()
  rmSync(dir, { recursive: true, force: true })
})

const node: StatObjectRef = { nodeId: 'node-a', kind: 'node', name: 'node-a' }

/** A bucket boundary `hoursAgo` in the past, so a test can place samples INSIDE
 *  one known bucket and predict the mean's timestamp exactly. */
function bucketStart(hoursAgo: number): number {
  return Math.floor((NOW - hoursAgo * HOUR) / STAT_BUCKET_MS) * STAT_BUCKET_MS
}

function points() {
  return readStatsByKind('node', 'cpu_percent', 0)[0]?.points ?? []
}

/**
 * A flow metric, built from the declared suffix rather than spelled literally,
 * so this test breaks if the rule in `shared/stats.ts` ever moves.
 *
 * The cast is deliberate and temporary: the four real `_count` metrics land
 * with `wall-stats-producer-token-usage`, which is a sibling branch on this
 * epic. The retention rule is a property of the SUFFIX, not of any one metric,
 * so it is testable -- and must be in place -- before the first producer of one
 * exists. That ordering is the point of the card: the loss happens at the first
 * sweep after a flow metric starts being written, reader or no reader.
 */
const FLOW = `tokens_in${STAT_FLOW_SUFFIX}` as StatMetric

function flowPoints() {
  return readStatsByKind('node', FLOW, 0)[0]?.points ?? []
}

describe('downsampling the tail', () => {
  test('folds one bucket of raw samples into a single mean at the bucket start', () => {
    const base = bucketStart(50) // older than the 48h raw window
    for (let i = 0; i < 10; i++) recordStat(node, 'cpu_percent', i, base + i * 10_000)
    flushStats()
    expect(points()).toHaveLength(10)

    // Nine of the ten sit off a bucket edge; the tenth IS the edge and is
    // rewritten in place with the mean.
    expect(sweepStats(NOW).collapsed).toBe(9)
    expect(points()).toEqual([{ ts: base, value: 4.5 }])
  })

  test('leaves everything inside the 48h raw window exactly as filed', () => {
    for (let i = 0; i < 5; i++) recordStat(node, 'cpu_percent', i, NOW - i * 7_000)
    flushStats()

    expect(sweepStats(NOW).collapsed).toBe(0)
    expect(points()).toHaveLength(5)
  })

  test('two buckets stay two points -- the fold is per bucket, not per series', () => {
    const older = bucketStart(50)
    const newer = bucketStart(49)
    recordStat(node, 'cpu_percent', 10, older + 1_000)
    recordStat(node, 'cpu_percent', 30, older + 2_000)
    recordStat(node, 'cpu_percent', 80, newer + 1_000)
    flushStats()

    sweepStats(NOW)
    expect(points()).toEqual([
      { ts: older, value: 20 },
      { ts: newer, value: 80 },
    ])
  })

  test('is idempotent -- a second sweep finds nothing left to collapse', () => {
    const base = bucketStart(50)
    for (let i = 0; i < 6; i++) recordStat(node, 'cpu_percent', i * 2, base + i * 20_000)
    flushStats()

    sweepStats(NOW)
    const after = points()
    expect(sweepStats(NOW).collapsed).toBe(0)
    expect(points()).toEqual(after)
  })

  test('the boundary is 48h, not "old-ish"', () => {
    // Two samples inside the same bucket, one either side of the cutoff. Only
    // the older one is eligible, and one sample makes a bucket of itself.
    const stale = NOW - STAT_RAW_MS - 61_000
    recordStat(node, 'cpu_percent', 5, stale)
    recordStat(node, 'cpu_percent', 6, NOW - STAT_RAW_MS + 61_000)
    flushStats()

    sweepStats(NOW)
    expect(points().map(p => p.value)).toEqual([5, 6])
    expect(points()[0]?.ts).toBe(Math.floor(stale / STAT_BUCKET_MS) * STAT_BUCKET_MS)
  })
})

describe('a flow sums where a gauge averages', () => {
  test('one sweep collapses both kinds in the same bucket, each its own way', () => {
    const base = bucketStart(50)
    // Same object, same 5-minute bucket, three readings of each metric. The
    // gauge's three levels average to 20; the flow's three per-message deltas
    // are a volume and total 600. Averaging the flow would file 200 -- the
    // "typical message" -- and delete the rows that prove otherwise.
    for (const [i, cpu] of [10, 20, 30].entries()) recordStat(node, 'cpu_percent', cpu, base + (i + 1) * 10_000)
    for (const [i, tok] of [100, 200, 300].entries()) recordStat(node, FLOW, tok, base + (i + 1) * 10_000)
    flushStats()

    expect(sweepStats(NOW).collapsed).toBe(6)
    expect(points()).toEqual([{ ts: base, value: 20 }])
    expect(flowPoints()).toEqual([{ ts: base, value: 600 }])
  })

  test('a summed bucket is idempotent -- the aligned row is a singleton, so SUM(x) = x', () => {
    // The property Done item 3 demanded be verified rather than assumed: SUM
    // over an already-collapsed range is a no-op for the same reason AVG is,
    // because the collapse left exactly ONE row per bucket to regroup. If the
    // DELETE ever stopped clearing the raws, this doubles.
    const base = bucketStart(50)
    for (const [i, tok] of [100, 200, 300].entries()) recordStat(node, FLOW, tok, base + (i + 1) * 10_000)
    flushStats()

    sweepStats(NOW)
    expect(flowPoints()).toEqual([{ ts: base, value: 600 }])
    expect(sweepStats(NOW).collapsed).toBe(0)
    expect(flowPoints()).toEqual([{ ts: base, value: 600 }])
  })

  test('a late raw folded into a summed bucket adds to the total rather than diluting it', () => {
    // The docblock's late-arrival note, checked: for a flow the second fold is
    // sum(total-so-far, late), which is simply the total. This is the one place
    // SUM is strictly better behaved than AVG, not merely equally safe.
    const base = bucketStart(50)
    for (const [i, tok] of [100, 200, 300].entries()) recordStat(node, FLOW, tok, base + (i + 1) * 10_000)
    flushStats()
    sweepStats(NOW)

    recordStat(node, FLOW, 100, base + 40_000)
    flushStats()
    sweepStats(NOW)
    expect(flowPoints()).toEqual([{ ts: base, value: 700 }])
  })

  test('a flow inside the 48h window is untouched -- every message is still its own row', () => {
    recordStat(node, FLOW, 100, NOW - 9_000)
    recordStat(node, FLOW, 200, NOW - 8_000)
    flushStats()

    expect(sweepStats(NOW).collapsed).toBe(0)
    expect(flowPoints().map(p => p.value)).toEqual([100, 200])
  })
})

describe('the hard bound', () => {
  test('drops everything past 90 days', () => {
    recordStat(node, 'cpu_percent', 1, bucketStart(24 * 100)) // aligned: not a collapse
    recordStat(node, 'cpu_percent', 2, NOW - 1_000)
    flushStats()

    const swept = sweepStats(NOW)
    expect(swept.deleted).toBe(1)
    expect(points().map(p => p.value)).toEqual([2])
  })

  test('a row exactly at the bound survives; one older does not', () => {
    recordStat(node, 'cpu_percent', 1, bucketStart(24 * 91))
    recordStat(node, 'cpu_percent', 2, NOW - STAT_RETENTION_MS + 10 * HOUR)
    flushStats()

    sweepStats(NOW)
    expect(points().map(p => p.value)).toEqual([2])
  })

  test('a sweep with nothing to do reports nothing and touches nothing', () => {
    recordStat(node, 'cpu_percent', 42, NOW)
    flushStats()

    expect(sweepStats(NOW)).toEqual({ collapsed: 0, deleted: 0 })
    expect(points()).toHaveLength(1)
  })
})
