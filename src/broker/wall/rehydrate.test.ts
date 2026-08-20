/**
 * THE point of the whole card: `docker compose up -d` must not blank the wall.
 *
 * A broker restart used to empty both rings, and an empty ring is visually
 * identical to a quiet fleet -- which is the failure that makes an ambient wall
 * untrustworthy. These tests kill the in-memory state, re-open the store, and
 * check that the sparkline and the five-hour chart RESUME.
 *
 * The other half is what must NOT happen: a restart is still a discontinuity,
 * and nothing here may draw a line across the hole as if it were a measurement.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodeStatsReport } from '../../shared/node-stats'
import type { ProfileUsageSnapshot } from '../../shared/protocol'
import { WALL_HOST_CPU_INTERVAL_MS } from '../../shared/wall'
import { nodeStatsStore } from '../node-stats-store'
import { closeStatsStore, flushStats, initStatsStore } from '../stats/store'
import { recordWallHostVitals, rehydrateWallHostVitals, resetWallHostVitals } from './host-vitals'
import { wallHub } from './index'
import { readPlanSeries, rehydratePlanSeries, resetPlanSeries, samplePlanUsage } from './plan-usage-series'

const NOW = Date.now()
const RESET_ISO = '2026-08-19T18:00:00.000Z'
const SENTINEL = { id: 'sent-1', alias: 'studio' }

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wall-rehydrate-test-'))
  initStatsStore(dir)
})
afterEach(() => {
  closeStatsStore()
  rmSync(dir, { recursive: true, force: true })
  resetWallHostVitals()
  resetPlanSeries()
  wallHub.reset()
  nodeStatsStore.clear()
})

function report(cpu: number, sampledAt: number): NodeStatsReport {
  return {
    type: 'node_stats',
    node: {
      nodeId: 'node-1',
      hostId: 'host-1',
      hostname: 'studio',
      osArch: 'darwin/arm64',
      agentVersion: '1.0.0',
      uptimeSec: 1000,
      sender: 'sentinel',
    },
    machine: {
      cpuPercent: cpu,
      load: { one: 1, five: 1, fifteen: 1, cores: 12 },
      memory: { usedBytes: 8, totalBytes: 16 },
      disk: { usedBytes: 50, totalBytes: 100, mount: '/' },
    },
    sampledAt,
  }
}

function snapshot(usedPercent: number): ProfileUsageSnapshot {
  return {
    profile: 'default',
    authed: true,
    polledAt: NOW,
    fiveHour: { usedPercent, resetAt: RESET_ISO },
    sevenDay: { usedPercent: 12, resetAt: RESET_ISO },
  }
}

/**
 * Everything the broker forgets when the process dies: both rings, the hub, and
 * the store's own buffer + object cache. The directory survives, which is the
 * whole point.
 */
function restartBroker(): void {
  flushStats()
  closeStatsStore()
  resetWallHostVitals()
  resetPlanSeries()
  wallHub.reset()
  initStatsStore(dir)
}

describe('the CPU sparkline', () => {
  test('resumes mid-series after a restart instead of coming back blank', () => {
    for (let i = 0; i < 8; i++) recordWallHostVitals(report(i * 10, NOW - (8 - i) * WALL_HOST_CPU_INTERVAL_MS))
    restartBroker()

    // Before rehydration the ring is what a restart used to leave behind.
    expect(rehydrateWallHostVitals(NOW)).toBe(1)

    const socket = { send: () => 0 }
    wallHub.subscribe(socket)
    recordWallHostVitals(report(99, NOW))
    expect(wallHub.state.snapshot().hosts[0]?.cpuHistory).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 99])
  })

  // A ring is POSITIONS, not timestamps -- there is no way to say "six slots are
  // missing here". So a long outage restores nothing rather than silently
  // compressing the hole and misdating every sample to its left.
  test('refuses to restore across an outage longer than six slots', () => {
    for (let i = 0; i < 8; i++) recordWallHostVitals(report(i * 10, NOW - 120_000 - i * WALL_HOST_CPU_INTERVAL_MS))
    restartBroker()

    expect(rehydrateWallHostVitals(NOW)).toBe(0)

    const socket = { send: () => 0 }
    wallHub.subscribe(socket)
    recordWallHostVitals(report(99, NOW))
    // One point, honestly: the five minutes before the restart are in the table
    // for anything that draws a real time axis, not smeared onto this one.
    expect(wallHub.state.snapshot().hosts[0]?.cpuHistory).toEqual([99])
  })

  test('restores each node separately', () => {
    recordWallHostVitals(report(10, NOW - 10_000))
    const other = report(90, NOW - 10_000)
    other.node.nodeId = 'node-2'
    other.node.hostname = 'nas'
    recordWallHostVitals(other)
    restartBroker()

    expect(rehydrateWallHostVitals(NOW)).toBe(2)
  })

  test('an empty store rehydrates nothing and says so', () => {
    expect(rehydrateWallHostVitals(NOW)).toBe(0)
  })
})

describe('the five-hour plan chart', () => {
  test('comes back with the hours that happened before the restart', () => {
    samplePlanUsage([snapshot(40)], SENTINEL, NOW - 3 * 60 * 60 * 1000)
    samplePlanUsage([snapshot(55)], SENTINEL, NOW - 2 * 60 * 60 * 1000)
    samplePlanUsage([snapshot(70)], SENTINEL, NOW - 60 * 60 * 1000)
    restartBroker()

    expect(rehydratePlanSeries(NOW)).toBe(3)
    const held = readPlanSeries(NOW)
    expect(held.map(s => s.utilization)).toEqual([40, 55, 70])
    // The alias is what the series key and the `&host` filter use; it survived
    // as the object's label, so the restored series is the same series.
    expect(held.map(s => s.node)).toEqual(['studio', 'studio', 'studio'])
  })

  test('a restored sample invents no reset instant and no poll time', () => {
    samplePlanUsage([snapshot(40)], SENTINEL, NOW - 60 * 60 * 1000)
    restartBroker()
    rehydratePlanSeries(NOW)

    const s = readPlanSeries(NOW)[0]
    expect(s?.state).toBe('ok')
    expect(s?.resetsAt).toBeUndefined()
    expect(s?.polledAt).toBeUndefined()
    expect(s?.stale).toBeUndefined()
  })

  // G4: the outage IS a hole. The first live sample after it says so, and the
  // pane is then free to break the line rather than draw across it.
  test('marks the outage on the first live sample after it', () => {
    samplePlanUsage([snapshot(40)], SENTINEL, NOW - 20 * 60 * 1000)
    restartBroker()
    rehydratePlanSeries(NOW)

    const [live] = samplePlanUsage([snapshot(75)], SENTINEL, NOW)
    expect(live?.gapBefore).toBe(true)
    // Only the FIRST one. The series is continuous again after it.
    const [next] = samplePlanUsage([snapshot(76)], SENTINEL, NOW + 5 * 60 * 1000)
    expect(next?.gapBefore).toBeUndefined()
  })

  test('a blink shorter than the series spacing is not a gap', () => {
    samplePlanUsage([snapshot(40)], SENTINEL, NOW - 30_000)
    restartBroker()
    rehydratePlanSeries(NOW)

    const [live] = samplePlanUsage([snapshot(75)], SENTINEL, NOW)
    expect(live?.gapBefore).toBeUndefined()
  })

  test('an unauthed or errored profile leaves NOTHING behind to restore', () => {
    samplePlanUsage([{ profile: 'default', authed: false, polledAt: NOW }], SENTINEL, NOW - 60 * 60 * 1000)
    samplePlanUsage(
      [{ profile: 'other', authed: true, polledAt: NOW, error: { kind: 'http', status: 429, detail: '429' } }],
      SENTINEL,
      NOW - 60 * 60 * 1000,
    )
    restartBroker()

    // A placeholder 0 would draw a flat line at the bottom of the chart and call
    // it a measurement. There was no reading; there is no row.
    expect(rehydratePlanSeries(NOW)).toBe(0)
  })
})
