/**
 * The two things the broker half of S1 has to get right: the ring stays bounded,
 * and a percentage with no denominator is absent rather than zero.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { NodeStatsReport } from '../../shared/node-stats'
import { WALL_HOST_CPU_SAMPLES } from '../../shared/wall'
import { nodeStatsStore } from '../node-stats-store'
import { recordWallHostVitals, resetWallHostVitals, seedWallHostVitals, wallHostVitalsFrom } from './host-vitals'
import { wallHub } from './index'

// PERMANENT (overseer ruling, gen 17): a fixture builder inside a test file.
// Cyclomatic and cognitive are both under threshold; CRAP trips only because
// fallow measures the test file's own coverage, and "write a test for the test"
// is not a real action. Never renew-with-a-card; this one does not expire.
// fallow-ignore-next-line complexity
function report(
  over: {
    nodeId?: string
    hostname?: string
    cpu?: number
    memUsed?: number
    memTotal?: number
    diskUsed?: number
    diskTotal?: number
    conversations?: number
    sampledAt?: number
  } = {},
): NodeStatsReport {
  return {
    type: 'node_stats',
    node: {
      nodeId: over.nodeId ?? 'node-1',
      hostId: 'host-1',
      hostname: over.hostname ?? 'studio',
      osArch: 'darwin/arm64',
      agentVersion: '1.0.0',
      uptimeSec: 1000,
      sender: 'sentinel',
    },
    machine: {
      cpuPercent: over.cpu ?? 42.06,
      load: { one: 3.216, five: 2, fifteen: 1, cores: 12 },
      memory: { usedBytes: over.memUsed ?? 8, totalBytes: over.memTotal ?? 16 },
      disk: { usedBytes: over.diskUsed ?? 99, totalBytes: over.diskTotal ?? 100, mount: '/' },
    },
    ...(over.conversations !== undefined ? { sentinel: { conversationCount: over.conversations } } : {}),
    sampledAt: over.sampledAt ?? 1_700_000_000_000,
  }
}

/** A socket the hub will accept and whose frames we can read back. */
function fakeSocket() {
  const sent: string[] = []
  return { socket: { send: (data: string) => sent.push(data) }, sent }
}

afterEach(() => {
  resetWallHostVitals()
  wallHub.reset()
  nodeStatsStore.clear()
})

describe('wallHostVitalsFrom', () => {
  test('projects the frame onto the compact row, rounded to one decimal', () => {
    const row = wallHostVitalsFrom(report({ conversations: 7 }), [1, 2, 3])
    expect(row).toMatchObject({
      nodeId: 'node-1',
      alias: 'studio',
      at: 1_700_000_000_000,
      cpuPct: 42.1,
      memPct: 50,
      diskPct: 99,
      load1: 3.2,
      cores: 12,
      conversations: 7,
    })
    expect(row.cpuHistory).toEqual([1, 2, 3])
  })

  test('a missing denominator leaves the meter ABSENT, never 0%', () => {
    const row = wallHostVitalsFrom(report({ memTotal: 0, diskTotal: 0 }), [])
    expect(row.memPct).toBeUndefined()
    expect(row.diskPct).toBeUndefined()
  })

  test('a reporter frame carries no conversation count rather than zero', () => {
    const row = wallHostVitalsFrom(report(), [])
    expect(row.conversations).toBeUndefined()
  })

  test('copies the ring, so a later sample cannot mutate an already-sent row', () => {
    const ring = [1, 2]
    const row = wallHostVitalsFrom(report(), ring)
    ring.push(3)
    expect(row.cpuHistory).toEqual([1, 2])
  })
})

describe('the CPU ring', () => {
  test('is bounded and rolls oldest-out', () => {
    const { socket } = fakeSocket()
    wallHub.subscribe(socket)
    const total = WALL_HOST_CPU_SAMPLES + 25
    for (let i = 0; i < total; i++) recordWallHostVitals(report({ cpu: i }))

    const history = wallHub.state.snapshot().hosts[0]?.cpuHistory ?? []
    expect(history).toHaveLength(WALL_HOST_CPU_SAMPLES)
    // Oldest kept sample is `total - cap`; newest is the last one filed.
    expect(history[0]).toBe(total - WALL_HOST_CPU_SAMPLES)
    expect(history.at(-1)).toBe(total - 1)
  })

  test('is per node -- two boxes do not share a series', () => {
    const { socket } = fakeSocket()
    wallHub.subscribe(socket)
    recordWallHostVitals(report({ nodeId: 'a', hostname: 'studio', cpu: 10 }))
    recordWallHostVitals(report({ nodeId: 'b', hostname: 'nas', cpu: 90 }))
    recordWallHostVitals(report({ nodeId: 'a', hostname: 'studio', cpu: 11 }))

    const hosts = wallHub.state.snapshot().hosts
    expect(hosts.find(h => h.nodeId === 'a')?.cpuHistory).toEqual([10, 11])
    expect(hosts.find(h => h.nodeId === 'b')?.cpuHistory).toEqual([90])
  })

  test('fills while NOBODY is watching, so a cold wall opens with history', () => {
    for (let i = 0; i < 4; i++) recordWallHostVitals(report({ cpu: i }))
    expect(wallHub.subscriberCount()).toBe(0)

    // The samples the ring absorbed unwatched are what the store now replays.
    nodeStatsStore.record(report({ cpu: 3 }))
    const { socket } = fakeSocket()
    wallHub.subscribe(socket)
    expect(seedWallHostVitals()).toBe(1)
    expect(wallHub.state.snapshot().hosts[0]?.cpuHistory).toEqual([0, 1, 2, 3])
  })
})

describe('the seed', () => {
  test('replays every stored node, including one that has gone quiet', () => {
    nodeStatsStore.record(report({ nodeId: 'live', hostname: 'studio', sampledAt: 2_000 }))
    nodeStatsStore.record(report({ nodeId: 'quiet', hostname: 'nas', sampledAt: 1_000 }))
    const { socket } = fakeSocket()
    wallHub.subscribe(socket)

    expect(seedWallHostVitals()).toBe(2)
    const hosts = wallHub.state.snapshot().hosts
    expect(hosts.map(h => h.nodeId).sort()).toEqual(['live', 'quiet'])
    // Nothing here decides staleness -- the row carries `at` and the pane reads it.
    expect(hosts.find(h => h.nodeId === 'quiet')?.at).toBe(1_000)
  })

  test('a node with no ring yet still seeds one point rather than an empty line', () => {
    nodeStatsStore.record(report({ cpu: 12.34 }))
    const { socket } = fakeSocket()
    wallHub.subscribe(socket)
    seedWallHostVitals()
    expect(wallHub.state.snapshot().hosts[0]?.cpuHistory).toEqual([12.3])
  })
})
