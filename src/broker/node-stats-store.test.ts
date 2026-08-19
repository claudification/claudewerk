/**
 * Card `node-stats-contract`, "Done means": HOST DEDUPE.
 *
 * "Machine facts are per HOST, sentinel facts are per SENTINEL. Two agents on
 * one box must not double-count the machine. Key rows by node id, label by
 * hostname, dedupe machine stats per host."
 *
 * The collapse itself is `dedupeMachineStatsByHost` in the shared contract and
 * is unit-tested there. THIS file pins that the broker store keys per NODE and
 * delegates the host collapse rather than growing a second implementation.
 */

import { describe, expect, it } from 'bun:test'
import { type MachineStats, NODE_STATS_STALE_AFTER_MS, type NodeStatsReport } from '../shared/node-stats'
import { FIXTURE_MACHINE } from '../shared/node-stats-fixture'
import { createNodeStatsStore } from './node-stats-store'

interface SampleOpts {
  nodeId: string
  hostId?: string
  hostname?: string
  sampledAt?: number
  sender?: 'sentinel' | 'reporter'
  machine?: MachineStats
}

function sample(opts: SampleOpts): NodeStatsReport {
  return {
    type: 'node_stats',
    node: {
      nodeId: opts.nodeId,
      hostId: opts.hostId ?? 'host-studio',
      hostname: opts.hostname ?? 'studio',
      osArch: 'darwin/arm64',
      agentVersion: 'abc1234',
      uptimeSec: 1000,
      sender: opts.sender ?? 'reporter',
    },
    machine: opts.machine ?? FIXTURE_MACHINE,
    sampledAt: opts.sampledAt ?? 1_000_000,
  }
}

const withRam = (totalBytes: number): MachineStats => ({ ...FIXTURE_MACHINE, memory: { usedBytes: 1, totalBytes } })

describe('node-stats store: rows keyed by node id', () => {
  it('two agents on ONE box stay two rows', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'snt-1', sender: 'sentinel' }))
    store.record(sample({ nodeId: 'rpt-1', sender: 'reporter' }))
    expect(store.size()).toBe(2)
    expect(
      store
        .nodes()
        .map(n => n.report.node.nodeId)
        .sort(),
    ).toEqual(['rpt-1', 'snt-1'])
  })

  it('a re-report from the same node REPLACES its row, never appends', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'snt-1', sampledAt: 1 }))
    store.record(sample({ nodeId: 'snt-1', sampledAt: 2 }))
    expect(store.size()).toBe(1)
    expect(store.get('snt-1')?.report.sampledAt).toBe(2)
  })

  it('stamps receivedAt from the BROKER, not the sender clock', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'a', sampledAt: 5 }), 999)
    expect(store.get('a')?.receivedAt).toBe(999)
    expect(store.get('a')?.report.sampledAt).toBe(5)
  })
})

describe('node-stats store: machine facts deduped per HOST', () => {
  it('two agents on one box produce exactly ONE machine row', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'snt-1', sampledAt: 10 }))
    store.record(sample({ nodeId: 'rpt-1', sampledAt: 20 }))
    const machines = store.machines()
    expect(machines.length).toBe(1)
    expect(machines[0].hostname).toBe('studio')
    expect(machines[0].nodeIds).toEqual(['rpt-1', 'snt-1'])
  })

  it('summing machine rows counts each box ONCE even with N agents on it', () => {
    const store = createNodeStatsStore()
    for (const nodeId of ['a', 'b', 'c']) {
      store.record(sample({ nodeId, hostId: 'host-studio', machine: withRam(8) }))
    }
    store.record(sample({ nodeId: 'd', hostId: 'host-beast', hostname: 'beast', machine: withRam(8) }))
    const totalRam = store.machines().reduce((sum, row) => sum + row.machine.memory.totalBytes, 0)
    // Two BOXES, 8 bytes each -- not four agents' worth.
    expect(store.machines().length).toBe(2)
    expect(totalRam).toBe(16)
  })

  it('dedupes on hostId, NOT hostname -- two networks can both have a `studio`', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'a', hostId: 'host-1', hostname: 'studio', machine: withRam(8) }))
    store.record(sample({ nodeId: 'b', hostId: 'host-2', hostname: 'studio', machine: withRam(8) }))
    expect(store.machines().length).toBe(2)
    expect(store.machines().reduce((s, r) => s + r.machine.memory.totalBytes, 0)).toBe(16)
  })

  it('the freshest sample owns the machine row', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'stale', sampledAt: 10, machine: { ...FIXTURE_MACHINE, cpuPercent: 5 } }))
    const owner = store.record(
      sample({ nodeId: 'fresh', sampledAt: 99, machine: { ...FIXTURE_MACHINE, cpuPercent: 88 } }),
    )
    expect(owner).toBe(true)
    expect(store.machines()[0].reportedBy).toBe('fresh')
    expect(store.machines()[0].machine.cpuPercent).toBe(88)
    expect(store.isMachineOwner('stale')).toBe(false)
  })

  it('ownership is stable (not flapping) when two samples share a millisecond', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'zzz', sampledAt: 50 }))
    store.record(sample({ nodeId: 'aaa', sampledAt: 50 }))
    expect(store.machines()[0].reportedBy).toBe('aaa')
    expect(store.machines()[0].reportedBy).toBe('aaa')
  })

  it('removing the owner hands the machine row to the surviving agent', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'old', sampledAt: 10 }))
    store.record(sample({ nodeId: 'new', sampledAt: 20 }))
    expect(store.machines()[0].reportedBy).toBe('new')
    store.remove('new')
    expect(store.machines().length).toBe(1)
    expect(store.machines()[0].reportedBy).toBe('old')
  })
})

describe('node-stats store: staleness', () => {
  it('a node past the stale window is stale; an unknown node is stale', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'a', sampledAt: 1000 }))
    expect(store.isStale('a', 1000 + NODE_STATS_STALE_AFTER_MS - 1)).toBe(false)
    expect(store.isStale('a', 1000 + NODE_STATS_STALE_AFTER_MS + 1)).toBe(true)
    expect(store.isStale('nobody')).toBe(true)
  })

  it('a stale node still appears in nodes() -- a hiccup must not delete a box', () => {
    const store = createNodeStatsStore()
    store.record(sample({ nodeId: 'a', sampledAt: 1 }))
    expect(store.nodes().length).toBe(1)
  })
})
