/**
 * Card `node-stats-reporter-credential`, "Done means":
 *   "The standalone reporter feeds the SAME broker handler as a sentinel does."
 *
 * Ingest behaviour of the one handler. The rejection matrix (a reporter may send
 * nothing else) lives in node-stats-capability.test.ts.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { NODE_STATS_INTERVAL_MS, REPORT_NODE_STATS } from '../../shared/node-stats'
import { createNodeStatsReporter } from '../../shared/node-stats-reporting'
import { routeMessage } from '../message-router'
import { nodeStatsStore } from '../node-stats-store'
import { registerAllHandlers } from './index'
import { asReporter, asSentinel, frame, HARNESS_MACHINE } from './node-stats-harness'

registerAllHandlers()

beforeEach(() => {
  nodeStatsStore.clear()
})

describe('a reporter key sends vitals', () => {
  it('accepts report_node_stats from a reporter connection', () => {
    const h = asReporter()
    expect(routeMessage(h.ctx, REPORT_NODE_STATS, frame())).toBe(true)
    expect(nodeStatsStore.size()).toBe(1)
    expect(h.broadcasts.some(b => b.type === 'node_stats_update')).toBe(true)
  })

  it('keys the row by the CREDENTIAL, not by the id on the wire', () => {
    const h = asReporter()
    routeMessage(h.ctx, REPORT_NODE_STATS, frame({ nodeId: 'snt-1-i-am-a-sentinel-honest' }))
    expect(nodeStatsStore.get('rpt-1')).toBeDefined()
    expect(nodeStatsStore.get('snt-1-i-am-a-sentinel-honest')).toBeUndefined()
    expect(h.logs.some(l => l.includes('nodeId mismatch'))).toBe(true)
  })

  it('stamps kind from the credential, so a reporter cannot claim to be a sentinel', () => {
    const h = asReporter()
    routeMessage(h.ctx, REPORT_NODE_STATS, frame())
    expect(nodeStatsStore.get('rpt-1')?.kind).toBe('reporter')
  })

  it('STRIPS a sentinel-only block smuggled into a reporter frame, and logs it', () => {
    const h = asReporter()
    routeMessage(h.ctx, REPORT_NODE_STATS, frame({ sentinel: { conversationCount: 99, profiles: [{ name: 'x' }] } }))
    expect(nodeStatsStore.get('rpt-1')?.sentinel).toBeUndefined()
    expect(h.logs.some(l => l.includes('stripped sentinel-only block'))).toBe(true)
  })

  it('rejects a malformed frame with a logged reason instead of storing junk', () => {
    const h = asReporter()
    routeMessage(h.ctx, REPORT_NODE_STATS, { type: REPORT_NODE_STATS, nodeId: 'x' })
    expect(nodeStatsStore.size()).toBe(0)
    expect(h.logs.some(l => l.includes('rejected') && l.includes('reason='))).toBe(true)
  })
})

describe('the standalone reporter feeds the SAME handler as a sentinel', () => {
  it('a sentinel frame lands in the same store with its extras intact', () => {
    const h = asSentinel()
    routeMessage(
      h.ctx,
      REPORT_NODE_STATS,
      frame({
        nodeId: 'machine-id',
        sentinel: { conversationCount: 3, profiles: [{ name: 'default', utilizationPercent: 61 }] },
      }),
    )
    const row = nodeStatsStore.get('snt-1')
    expect(row?.kind).toBe('sentinel')
    expect(row?.sentinel).toEqual({ conversationCount: 3, profiles: [{ name: 'default', utilizationPercent: 61 }] })
  })

  it('a sentinel machineId-as-nodeId is NOT logged as a mismatch (it cannot know its snt_ id)', () => {
    const h = asSentinel()
    routeMessage(h.ctx, REPORT_NODE_STATS, frame({ nodeId: 'machine-id' }))
    expect(h.logs.some(l => l.includes('nodeId mismatch'))).toBe(false)
  })

  it('a frame built by the SHARED runner is accepted by the broker handler verbatim', () => {
    // The end-to-end contract check: the exact bytes the standalone reporter
    // puts on the wire, parsed by the broker, with no adapter between.
    let onWire = ''
    const reporter = createNodeStatsReporter({
      nodeId: 'reporter@beast',
      agentVersion: 'abc1234',
      sampler: { sample: () => HARNESS_MACHINE },
      send: f => {
        onWire = JSON.stringify(f)
      },
    })
    reporter.tick()

    const h = asReporter()
    expect(routeMessage(h.ctx, REPORT_NODE_STATS, JSON.parse(onWire))).toBe(true)
    const row = nodeStatsStore.get('rpt-1')
    expect(row?.machine.cpuPercent).toBe(71)
    expect(row?.sentinel).toBeUndefined()
  })

  it('both senders share ONE cadence constant', () => {
    expect(NODE_STATS_INTERVAL_MS).toBe(5000)
  })

  it('two agents on one box: two rows, one machine owner', () => {
    const r = asReporter()
    const s = asSentinel()
    routeMessage(s.ctx, REPORT_NODE_STATS, frame({ hostname: 'studio', sampledAt: 10 }))
    routeMessage(r.ctx, REPORT_NODE_STATS, frame({ hostname: 'studio', sampledAt: 20 }))
    expect(nodeStatsStore.size()).toBe(2)
    expect(nodeStatsStore.machines().length).toBe(1)
    expect(r.broadcasts.at(-1)?.machineOwner).toBe(true)
    expect(s.broadcasts.at(-1)?.machineOwner).toBe(true) // it WAS the owner when it reported
    expect(nodeStatsStore.isMachineOwner('snt-1')).toBe(false)
  })
})
