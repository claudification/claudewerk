/**
 * Card `node-stats-reporter-credential`, "Done means":
 *   "The standalone reporter feeds the SAME broker handler as a sentinel does."
 *
 * Ingest behaviour of the one handler. The rejection matrix (a reporter may send
 * nothing else) lives in node-stats-capability.test.ts.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { NODE_STATS_INTERVAL_MS, NODE_STATS_MESSAGE } from '../../shared/node-stats'
import { FIXTURE_REPORTER_IDENTITY } from '../../shared/node-stats-fixture'
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
  it('accepts node_stats from a reporter connection', () => {
    const h = asReporter()
    expect(routeMessage(h.ctx, NODE_STATS_MESSAGE, frame())).toBe(true)
    expect(nodeStatsStore.size()).toBe(1)
    expect(h.broadcasts.some(b => b.type === 'node_stats_update')).toBe(true)
  })

  it('keys the row by the CREDENTIAL, not by the id on the wire', () => {
    const h = asReporter()
    routeMessage(h.ctx, NODE_STATS_MESSAGE, frame({ node: { nodeId: 'snt-1-i-am-a-sentinel-honest' } }))
    expect(nodeStatsStore.get('rpt-1')).toBeDefined()
    expect(nodeStatsStore.get('snt-1-i-am-a-sentinel-honest')).toBeUndefined()
    expect(h.logs.some(l => l.includes('nodeId mismatch'))).toBe(true)
  })

  it('stamps sender from the credential, so a reporter cannot CLAIM to be a sentinel', () => {
    const h = asReporter()
    // The nastiest version: claim sender=sentinel so the contract's own extras
    // rule would wave the extras through.
    routeMessage(
      h.ctx,
      NODE_STATS_MESSAGE,
      frame({ node: { sender: 'sentinel' }, sentinel: { conversationCount: 99 } }),
    )
    expect(h.logs.some(l => l.includes('claimed sender=sentinel'))).toBe(true)
    // Corrected to reporter -> the shared validator then REFUSES the extras.
    expect(nodeStatsStore.size()).toBe(0)
    expect(h.logs.some(l => l.includes('sentinel-only extras are not allowed on a reporter frame'))).toBe(true)
  })

  it('a clean reporter frame is stored with sender=reporter and no extras', () => {
    const h = asReporter()
    routeMessage(h.ctx, NODE_STATS_MESSAGE, frame())
    const row = nodeStatsStore.get('rpt-1')
    expect(row?.report.node.sender).toBe('reporter')
    expect(row?.report.sentinel).toBeUndefined()
  })

  it('rejects a malformed frame with logged reasons instead of storing junk', () => {
    const h = asReporter()
    routeMessage(h.ctx, NODE_STATS_MESSAGE, { type: NODE_STATS_MESSAGE, node: { nodeId: 'x' } })
    expect(nodeStatsStore.size()).toBe(0)
    expect(h.logs.some(l => l.includes('rejected') && l.includes('errors='))).toBe(true)
  })

  it('rejects a profile entry smuggling configDir / env past the PROFILE-ENV BOUNDARY', () => {
    const h = asSentinel()
    routeMessage(
      h.ctx,
      NODE_STATS_MESSAGE,
      frame({
        node: { sender: 'sentinel' },
        sentinel: {
          conversationCount: 1,
          profiles: [{ name: 'work', utilizationPercent: 50, configDir: '/Users/jonas/.claude-work' }],
        },
      } as never),
    )
    expect(nodeStatsStore.size()).toBe(0)
    expect(h.logs.some(l => l.includes('configDir: not allowed'))).toBe(true)
  })
})

describe('the standalone reporter feeds the SAME handler as a sentinel', () => {
  it('a sentinel frame lands in the same store with its extras intact', () => {
    const h = asSentinel()
    routeMessage(
      h.ctx,
      NODE_STATS_MESSAGE,
      frame({
        node: { nodeId: 'machine-id', sender: 'sentinel' },
        sentinel: { conversationCount: 3, profiles: [{ name: 'default', utilizationPercent: 61 }] },
      }),
    )
    const row = nodeStatsStore.get('snt-1')
    expect(row?.report.node.sender).toBe('sentinel')
    expect(row?.report.sentinel).toEqual({
      conversationCount: 3,
      profiles: [{ name: 'default', utilizationPercent: 61 }],
    })
  })

  it('a sentinel machineId-as-nodeId is NOT logged as a mismatch (it cannot know its snt_ id)', () => {
    const h = asSentinel()
    routeMessage(h.ctx, NODE_STATS_MESSAGE, frame({ node: { nodeId: 'machine-id', sender: 'sentinel' } }))
    expect(h.logs.some(l => l.includes('nodeId mismatch'))).toBe(false)
  })

  it('a frame built by the SHARED runner is accepted by the broker handler verbatim', () => {
    // The end-to-end contract check: the exact bytes the standalone reporter
    // puts on the wire, parsed by the broker, with no adapter between.
    let onWire = ''
    createNodeStatsReporter({
      identity: FIXTURE_REPORTER_IDENTITY,
      sampler: { sample: () => HARNESS_MACHINE },
      send: report => {
        onWire = JSON.stringify(report)
      },
    }).tick()

    const h = asReporter()
    expect(routeMessage(h.ctx, NODE_STATS_MESSAGE, JSON.parse(onWire))).toBe(true)
    const row = nodeStatsStore.get('rpt-1')
    expect(row?.report.machine.cpuPercent).toBe(HARNESS_MACHINE.cpuPercent)
    expect(row?.report.sentinel).toBeUndefined()
  })

  it('both senders share ONE cadence constant', () => {
    expect(NODE_STATS_INTERVAL_MS).toBe(5_000)
  })

  it('two agents on one box: two rows, one machine owner', () => {
    const r = asReporter()
    const s = asSentinel()
    routeMessage(s.ctx, NODE_STATS_MESSAGE, frame({ node: { sender: 'sentinel' }, sampledAt: 10 }))
    routeMessage(r.ctx, NODE_STATS_MESSAGE, frame({ sampledAt: 20 }))
    expect(nodeStatsStore.size()).toBe(2)
    expect(nodeStatsStore.machines().length).toBe(1)
    expect(r.broadcasts.at(-1)?.machineOwner).toBe(true)
    expect(s.broadcasts.at(-1)?.machineOwner).toBe(true) // it WAS the owner when it reported
    expect(nodeStatsStore.isMachineOwner('snt-1')).toBe(false)
  })

  it('the broadcast carries the dedupe verdict so consumers do not recompute it', () => {
    const h = asReporter()
    routeMessage(h.ctx, NODE_STATS_MESSAGE, frame())
    const update = h.broadcasts.at(-1)
    expect(update?.type).toBe('node_stats_update')
    expect(update?.machineOwner).toBe(true)
    expect(typeof update?.receivedAt).toBe('number')
  })
})
