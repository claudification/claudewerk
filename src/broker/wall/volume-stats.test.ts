/**
 * The card's acceptance test: two mounts on ONE node are TWO series, and the
 * node's own disk number did not move while that became true.
 *
 * These go through the real store on a temp directory rather than a mock,
 * because the thing being proved is what ends up in `stat_objects` -- one row
 * per mount, keyed on the mount path, surviving a restart.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodeStatsReport, VolumeStats } from '../../shared/node-stats'
import { readStatsByKind } from '../stats/read'
import { closeStatsStore, flushStats, initStatsStore } from '../stats/store'
import { recordWallHostVitals, resetWallHostVitals } from './host-vitals'
import { wallHub } from './index'
import { recordWallVolumeStats, volumeStatObject } from './volume-stats'

/** Relative to the real clock, for the same reason `stats/store.test.ts` is:
 *  `initStatsStore()` sweeps against `Date.now()`, so a hard-coded epoch from
 *  2023 is retention-swept away before the restart assertion can read it back.
 *  Every assertion is still exact -- the arithmetic is. */
const AT = Date.now() - 60_000

/** Two mounts on one box: the boot volume nearly full, an external one empty. */
const ROOT: VolumeStats = { usedBytes: 990, totalBytes: 1_000, mount: '/' }
const FINT: VolumeStats = { usedBytes: 100, totalBytes: 1_000, mount: '/Volumes/Fint' }

function report(over: { nodeId?: string; volumes?: VolumeStats[]; at?: number } = {}): NodeStatsReport {
  return {
    type: 'node_stats',
    node: {
      nodeId: over.nodeId ?? 'node-1',
      hostId: 'host-1',
      hostname: 'studio',
      osArch: 'darwin/arm64',
      agentVersion: '1.0.0',
      uptimeSec: 1_000,
      sender: 'sentinel',
    },
    machine: {
      cpuPercent: 40,
      load: { one: 1, five: 1, fifteen: 1, cores: 12 },
      memory: { usedBytes: 8, totalBytes: 16 },
      // The node's own volume: 50%, deliberately DIFFERENT from either volume
      // below, so a test that confuses the two cannot pass.
      disk: { usedBytes: 50, totalBytes: 100, mount: '/' },
      ...(over.volumes ? { volumes: over.volumes } : {}),
    },
    sampledAt: over.at ?? AT,
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'volume-stats-test-'))
  initStatsStore(dir)
})
afterEach(() => {
  closeStatsStore()
  rmSync(dir, { recursive: true, force: true })
  resetWallHostVitals()
  wallHub.reset()
})

function volumeSeries(metric: 'disk_percent' | 'disk_used_bytes' | 'disk_total_bytes') {
  return readStatsByKind('volume', metric, 0)
}

describe('one object per mount', () => {
  test('two mounts on one node are TWO series, not one', () => {
    recordWallVolumeStats(report({ volumes: [ROOT, FINT] }))
    flushStats()

    const series = volumeSeries('disk_percent')
    expect(series).toHaveLength(2)
    expect(series.map(s => s.ref.name).sort()).toEqual(['/', '/Volumes/Fint'])
    expect(series.find(s => s.ref.name === '/')?.points).toEqual([{ ts: AT, value: 99 }])
    expect(series.find(s => s.ref.name === '/Volumes/Fint')?.points).toEqual([{ ts: AT, value: 10 }])
  })

  test('the same mount on two nodes stays two series -- a mount path is per box', () => {
    recordWallVolumeStats(report({ nodeId: 'studio', volumes: [ROOT] }))
    recordWallVolumeStats(report({ nodeId: 'nas', volumes: [{ ...ROOT, usedBytes: 100 }] }))
    flushStats()

    const series = volumeSeries('disk_percent')
    expect(series).toHaveLength(2)
    expect(series.map(s => s.ref.nodeId).sort()).toEqual(['nas', 'studio'])
  })

  test('a series accumulates across ticks instead of forking', () => {
    recordWallVolumeStats(report({ volumes: [ROOT], at: AT }))
    recordWallVolumeStats(report({ volumes: [{ ...ROOT, usedBytes: 995 }], at: AT + 5_000 }))
    flushStats()

    const root = volumeSeries('disk_percent')[0]
    expect(root?.points.map(p => p.value)).toEqual([99, 99.5])
  })

  test('files the bytes beside the percentage -- "89%" cannot say if 10 GB helps', () => {
    recordWallVolumeStats(report({ volumes: [FINT] }))
    flushStats()

    expect(volumeSeries('disk_used_bytes')[0]?.points).toEqual([{ ts: AT, value: 100 }])
    expect(volumeSeries('disk_total_bytes')[0]?.points).toEqual([{ ts: AT, value: 1_000 }])
  })

  // THE TRAP THIS CARD MUST NOT RE-EARN (`node-stats-disk-used-two-definitions`):
  // the percentage and the byte count come from ONE number computed once at the
  // collector. If they can disagree, that is the bug.
  test('the percentage is the stored bytes, not a second reading', () => {
    recordWallVolumeStats(report({ volumes: [ROOT] }))
    flushStats()

    const percent = volumeSeries('disk_percent')[0]?.points[0]?.value ?? 0
    const used = volumeSeries('disk_used_bytes')[0]?.points[0]?.value ?? 0
    const total = volumeSeries('disk_total_bytes')[0]?.points[0]?.value ?? 1
    expect(percent).toBe(Math.round((used / total) * 1_000) / 10)
  })

  test('a volume with no denominator has NO meter, but still says so in bytes', () => {
    recordWallVolumeStats(report({ volumes: [{ usedBytes: 0, totalBytes: 0, mount: '/mnt/unreadable' }] }))
    flushStats()

    expect(volumeSeries('disk_percent')).toEqual([])
    expect(volumeSeries('disk_total_bytes')[0]?.points).toEqual([{ ts: AT, value: 0 }])
  })
})

describe('the node number is untouched', () => {
  test('a frame with volumes still files the node`s own disk_percent, unchanged', () => {
    const frame = report({ volumes: [ROOT, FINT] })
    recordWallHostVitals(frame)
    recordWallVolumeStats(frame)
    flushStats()

    // The node's disk is 50/100 and stays 50 -- not 99 (its root volume), not an
    // average of the two. This ADDS resolution; it does not re-point the number.
    const node = readStatsByKind('node', 'disk_percent', 0)
    expect(node).toHaveLength(1)
    expect(node[0]?.ref.name).toBe('node-1')
    expect(node[0]?.points).toEqual([{ ts: AT, value: 50 }])
  })

  test('a sender that never heard of volumes files nothing here at all', () => {
    const frame = report()
    recordWallHostVitals(frame)
    expect(recordWallVolumeStats(frame)).toBe(0)
    flushStats()

    expect(volumeSeries('disk_percent')).toEqual([])
    expect(readStatsByKind('node', 'disk_percent', 0)).toHaveLength(1)
  })
})

describe('the volume object', () => {
  test('is keyed by mount path and labelled by the volume name', () => {
    expect(volumeStatObject('node-1', FINT)).toEqual({
      nodeId: 'node-1',
      kind: 'volume',
      name: '/Volumes/Fint',
      label: 'Fint',
    })
  })

  test('root keeps `/` as its label rather than going blank', () => {
    expect(volumeStatObject('node-1', ROOT).label).toBe('/')
  })

  test('a mount path with a space in it is one name, not two', () => {
    const stuff: VolumeStats = { usedBytes: 1, totalBytes: 2, mount: '/Volumes/Stuff 1' }
    recordWallVolumeStats(report({ volumes: [stuff, FINT] }))
    flushStats()

    const series = volumeSeries('disk_percent')
    expect(series.map(s => s.ref.name).sort()).toEqual(['/Volumes/Fint', '/Volumes/Stuff 1'])
    expect(series.find(s => s.ref.name === '/Volumes/Stuff 1')?.ref.label).toBe('Stuff 1')
  })

  test('survives a broker restart with its series and its label intact', () => {
    recordWallVolumeStats(report({ volumes: [ROOT, FINT] }))
    flushStats()
    closeStatsStore()
    initStatsStore(dir)

    const series = volumeSeries('disk_percent')
    expect(series).toHaveLength(2)
    expect(series.find(s => s.ref.name === '/Volumes/Fint')?.ref.label).toBe('Fint')
  })
})
