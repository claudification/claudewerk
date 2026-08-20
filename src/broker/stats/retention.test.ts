/**
 * Retention. "Per-object-per-metric-per-second forever" is the failure mode a
 * narrow table invites, so the bound is exercised here rather than asserted in
 * prose: old rows COLLAPSE to 5-minute means, very old rows go, and running the
 * sweep twice changes nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StatObjectRef } from '../../shared/stats'
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
