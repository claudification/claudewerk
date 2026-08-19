/**
 * Card `node-stats-contract`, "Done means": HOST DEDUPE.
 *
 * "Machine facts are per HOST, sentinel facts are per SENTINEL. Two agents on
 * one box must not double-count the machine. Key rows by node id, label by
 * hostname, dedupe machine stats per host."
 */

import { describe, expect, it } from 'bun:test'
import { NODE_STATS_STALE_MS, type NodeStatsRecord } from '../shared/node-stats'
import { createNodeStatsStore } from './node-stats-store'

function sample(over: Partial<NodeStatsRecord> & Pick<NodeStatsRecord, 'nodeId' | 'hostname'>): NodeStatsRecord {
  return {
    type: 'report_node_stats',
    platform: 'darwin/arm64',
    agentVersion: 'abc1234',
    uptimeSec: 1000,
    sampledAt: 1_000_000,
    receivedAt: 1_000_000,
    kind: 'reporter',
    machine: {
      cpuPercent: 10,
      load: { avg1: 1, avg5: 1, avg15: 1, cores: 8 },
      memory: { usedBytes: 1, totalBytes: 2 },
      disk: { usedBytes: 1, totalBytes: 2, mount: '/' },
    },
    ...over,
  }
}

describe('node-stats store: rows keyed by node id', () => {
  it('two agents on ONE box stay two rows', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'snt-1', hostname: 'studio', kind: 'sentinel' }))
    store.record(sample({ nodeId: 'rpt-1', hostname: 'studio', kind: 'reporter' }))
    expect(store.size()).toBe(2)
    expect(
      store
        .nodes()
        .map(n => n.nodeId)
        .sort(),
    ).toEqual(['rpt-1', 'snt-1'])
  })

  it('a re-report from the same node REPLACES its row, never appends', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'snt-1', hostname: 'studio', sampledAt: 1 }))
    store.record(sample({ nodeId: 'snt-1', hostname: 'studio', sampledAt: 2 }))
    expect(store.size()).toBe(1)
    expect(store.get('snt-1')?.sampledAt).toBe(2)
  })
})

describe('node-stats store: machine facts deduped per HOST', () => {
  it('two agents on one box produce exactly ONE machine row', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'snt-1', hostname: 'studio', sampledAt: 10 }))
    store.record(sample({ nodeId: 'rpt-1', hostname: 'studio', sampledAt: 20 }))
    const machines = store.machines()
    expect(machines.length).toBe(1)
    expect(machines[0].hostname).toBe('studio')
    expect(machines[0].nodeIds).toEqual(['rpt-1', 'snt-1'])
  })

  it('summing machine rows counts each box ONCE even with N agents on it', () => {
    const store = createNodeStatsStore()
    for (const nodeId of ['a', 'b', 'c']) {
      store.record(
        sample({
          nodeId,
          hostname: 'studio',
          machine: { ...sample({ nodeId, hostname: 'studio' }).machine, memory: { usedBytes: 4, totalBytes: 8 } },
        }),
      )
    }
    store.record(
      sample({
        nodeId: 'd',
        hostname: 'beast',
        machine: { ...sample({ nodeId: 'd', hostname: 'beast' }).machine, memory: { usedBytes: 4, totalBytes: 8 } },
      }),
    )
    const totalRam = store.machines().reduce((sum, row) => sum + row.machine.memory.totalBytes, 0)
    // Two BOXES, 8 bytes each -- not four agents' worth.
    expect(store.machines().length).toBe(2)
    expect(totalRam).toBe(16)
  })

  it('the freshest sample owns the machine row', () => {
    const store = createNodeStatsStore()
    store.record(
      sample({
        nodeId: 'stale',
        hostname: 'studio',
        sampledAt: 10,
        machine: { ...sample({ nodeId: 'x', hostname: 'y' }).machine, cpuPercent: 5 },
      }),
    )
    const owner = store.record(
      sample({
        nodeId: 'fresh',
        hostname: 'studio',
        sampledAt: 99,
        machine: { ...sample({ nodeId: 'x', hostname: 'y' }).machine, cpuPercent: 88 },
      }),
    )
    expect(owner).toBe(true)
    expect(store.machines()[0].ownerNodeId).toBe('fresh')
    expect(store.machines()[0].machine.cpuPercent).toBe(88)
    expect(store.isMachineOwner('stale')).toBe(false)
  })

  it('ownership is stable (not flapping) when two samples share a millisecond', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'zzz', hostname: 'studio', sampledAt: 50 }))
    store.record(sample({ nodeId: 'aaa', hostname: 'studio', sampledAt: 50 }))
    expect(store.machines()[0].ownerNodeId).toBe('aaa')
    expect(store.machines()[0].ownerNodeId).toBe('aaa')
  })

  it('different hostnames are different machines', () => {
    const store = createNodeStatsStore()
    expect(store.record(sample({ nodeId: 'a', hostname: 'studio' }))).toBe(true)
    expect(store.record(sample({ nodeId: 'b', hostname: 'beast' }))).toBe(true)
    expect(store.machines().map(m => m.hostname)).toEqual(['beast', 'studio'])
  })

  it('removing the owner hands the machine row to the surviving agent', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'old', hostname: 'studio', sampledAt: 10 }))
    store.record(sample({ nodeId: 'new', hostname: 'studio', sampledAt: 20 }))
    expect(store.machines()[0].ownerNodeId).toBe('new')
    store.remove('new')
    expect(store.machines().length).toBe(1)
    expect(store.machines()[0].ownerNodeId).toBe('old')
  })
})

describe('node-stats store: staleness', () => {
  it('a node past the stale window is stale; an unknown node is stale', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'a', hostname: 'studio', receivedAt: 1000 }))
    expect(store.isStale('a', 1000 + NODE_STATS_STALE_MS - 1)).toBe(false)
    expect(store.isStale('a', 1000 + NODE_STATS_STALE_MS + 1)).toBe(true)
    expect(store.isStale('nobody')).toBe(true)
  })

  it('a stale node still appears in nodes() -- a hiccup must not delete a box', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'a', hostname: 'studio', receivedAt: 0 }))
    expect(store.nodes().length).toBe(1)
  })
})
