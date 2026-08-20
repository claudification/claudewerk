/**
 * THE STATS TABLE, the durability half.
 *
 * The one thing this store exists to make true: a broker that is killed and
 * re-opened still has the series. Everything else here is a way that could
 * quietly stop being true -- a buffer that never lands, an object row that forks
 * when a box is renamed, a replay that double-counts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StatObjectRef } from '../../shared/stats'
import { readStatsByKind } from './read'
import { closeStatsStore, flushStats, initStatsStore, recordStat } from './store'

/** Relative to the real clock: `initStatsStore()` sweeps against `Date.now()`,
 *  so a hard-coded epoch from last year would be swept away before the first
 *  assertion ran. Every assertion below is still exact -- the arithmetic is. */
const NOW = Date.now()
const SEC = 1_000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stats-store-test-'))
  initStatsStore(dir)
})
afterEach(() => {
  closeStatsStore()
  rmSync(dir, { recursive: true, force: true })
})

const nodeA: StatObjectRef = { nodeId: 'node-a', kind: 'node', name: 'node-a', label: 'studio' }
const nodeB: StatObjectRef = { nodeId: 'node-b', kind: 'node', name: 'node-b', label: 'nas' }

/** Simulate the process dying and coming back on the same directory. */
function restart(): void {
  closeStatsStore()
  initStatsStore(dir)
}

function seriesFor(nodeId: string, metric: 'cpu_percent' | 'mem_percent') {
  return readStatsByKind('node', metric, 0).find(s => s.ref.nodeId === nodeId)
}

describe('round trip', () => {
  // THE card's acceptance test: N samples, two objects, two metrics, drop
  // everything in memory, re-open, both series intact.
  test('survives a close and re-open with every series intact', () => {
    for (let i = 0; i < 30; i++) {
      recordStat(nodeA, 'cpu_percent', i, NOW - (30 - i) * SEC)
      recordStat(nodeA, 'mem_percent', 50 + i, NOW - (30 - i) * SEC)
      recordStat(nodeB, 'cpu_percent', 90 - i, NOW - (30 - i) * SEC)
    }
    flushStats()

    restart()

    expect(seriesFor('node-a', 'cpu_percent')?.points.map(p => p.value)).toEqual(
      Array.from({ length: 30 }, (_, i) => i),
    )
    expect(seriesFor('node-a', 'mem_percent')?.points.map(p => p.value)).toEqual(
      Array.from({ length: 30 }, (_, i) => 50 + i),
    )
    expect(seriesFor('node-b', 'cpu_percent')?.points.map(p => p.value)).toEqual(
      Array.from({ length: 30 }, (_, i) => 90 - i),
    )
  })

  test('the two metrics of one object do not bleed into each other', () => {
    recordStat(nodeA, 'cpu_percent', 11, NOW)
    recordStat(nodeA, 'mem_percent', 22, NOW)
    flushStats()

    expect(seriesFor('node-a', 'cpu_percent')?.points).toEqual([{ ts: NOW, value: 11 }])
    expect(seriesFor('node-a', 'mem_percent')?.points).toEqual([{ ts: NOW, value: 22 }])
  })

  test('an object with nothing in the window is ABSENT, not present-and-empty', () => {
    recordStat(nodeA, 'cpu_percent', 11, NOW - 60 * SEC)
    flushStats()

    expect(readStatsByKind('node', 'cpu_percent', NOW - 10 * SEC)).toEqual([])
  })
})

describe('batching', () => {
  test('nothing is queryable until it is flushed -- the buffer is real', () => {
    recordStat(nodeA, 'cpu_percent', 42, NOW)
    expect(readStatsByKind('node', 'cpu_percent', 0)).toEqual([])

    expect(flushStats()).toBe(1)
    expect(seriesFor('node-a', 'cpu_percent')?.points).toHaveLength(1)
  })

  test('a flush with nothing buffered writes nothing', () => {
    expect(flushStats()).toBe(0)
  })

  // The last window dying on exactly the restart this store exists for is the
  // whole failure. Shutdown drains the buffer before it closes the handle.
  test('closing the store FLUSHES what is buffered', () => {
    recordStat(nodeA, 'cpu_percent', 77, NOW)
    closeStatsStore() // no explicit flush
    initStatsStore(dir)

    expect(seriesFor('node-a', 'cpu_percent')?.points).toEqual([{ ts: NOW, value: 77 }])
  })

  test('a re-filed instant is ignored rather than counted twice', () => {
    recordStat(nodeA, 'cpu_percent', 42, NOW)
    flushStats()
    recordStat(nodeA, 'cpu_percent', 42, NOW)
    flushStats()

    expect(seriesFor('node-a', 'cpu_percent')?.points).toHaveLength(1)
  })

  test('a non-finite value or timestamp is refused at the door', () => {
    recordStat(nodeA, 'cpu_percent', Number.NaN, NOW)
    recordStat(nodeA, 'cpu_percent', 42, Number.POSITIVE_INFINITY)
    expect(flushStats()).toBe(0)
  })
})

describe('the object row', () => {
  test('renaming a box UPDATES the label instead of forking the series', () => {
    recordStat(nodeA, 'cpu_percent', 1, NOW - SEC)
    flushStats()
    recordStat({ ...nodeA, label: 'studio-2' }, 'cpu_percent', 2, NOW)
    flushStats()

    const all = readStatsByKind('node', 'cpu_percent', 0)
    expect(all).toHaveLength(1)
    expect(all[0]?.ref.label).toBe('studio-2')
    expect(all[0]?.points.map(p => p.value)).toEqual([1, 2])
  })

  test('the label survives a restart, so a rehydrated series still has a name', () => {
    recordStat(nodeA, 'cpu_percent', 1, NOW)
    flushStats()
    restart()

    expect(readStatsByKind('node', 'cpu_percent', 0)[0]?.ref.label).toBe('studio')
  })

  test('two kinds on the same node are two objects', () => {
    recordStat(nodeA, 'cpu_percent', 1, NOW)
    recordStat({ nodeId: 'node-a', kind: 'profile', name: 'default' }, 'plan_utilization_percent', 62, NOW)
    flushStats()

    expect(readStatsByKind('node', 'cpu_percent', 0)).toHaveLength(1)
    expect(readStatsByKind('profile', 'plan_utilization_percent', 0)).toHaveLength(1)
  })
})

describe('an uninitialized store', () => {
  test('swallows writes and reads instead of throwing', () => {
    closeStatsStore()
    expect(() => recordStat(nodeA, 'cpu_percent', 1, NOW)).not.toThrow()
    expect(flushStats()).toBe(0)
    expect(readStatsByKind('node', 'cpu_percent', 0)).toEqual([])
  })
})
