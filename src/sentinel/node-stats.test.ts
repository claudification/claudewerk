/**
 * The sentinel's OPTIONAL extras block.
 *
 * There is exactly ONE sentinel-only fact on this payload: the running
 * conversation count. Plan utilization is NOT here (decision 2026-08-19) -- it
 * rides `sentinel_usage_report`, which the sentinel already sends on its own
 * cadence. `node-stats.test.ts` fails the build if it ever reappears.
 */

import { describe, expect, it } from 'bun:test'
import { validateNodeStats } from '../shared/node-stats'
import { startSentinelNodeStats } from './node-stats'

function reporter(over: Partial<Parameters<typeof startSentinelNodeStats>[0]> = {}) {
  return startSentinelNodeStats({
    nodeId: 'machine-1',
    hostId: 'host-1',
    agentVersion: 'abc1234',
    conversationCount: () => 0,
    send: () => true,
    log: () => {},
    ...over,
  })
}

describe('the sentinel sender', () => {
  it('emits a valid frame WITH the extras block, on the socket it is handed', () => {
    const sent: unknown[] = []
    reporter({
      conversationCount: () => 4,
      send: frame => {
        sent.push(frame)
        return true
      },
    }).stop()

    expect(sent.length).toBe(1)
    const parsed = validateNodeStats(JSON.parse(JSON.stringify(sent[0])))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.report.sentinel).toEqual({ conversationCount: 4 })
    expect(parsed.report.node.sender).toBe('sentinel')
    expect(parsed.report.node.hostId).toBe('host-1')
  })

  it('carries NO profile fields -- the PROFILE-ENV BOUNDARY has nothing to cross', () => {
    const sent: unknown[] = []
    reporter({
      send: frame => {
        sent.push(frame)
        return true
      },
    }).stop()
    const serialised = JSON.stringify(sent[0])
    expect(serialised).not.toContain('profile')
    expect(serialised).not.toContain('utilization')
    expect(serialised).not.toContain('configDir')
  })

  it('re-evaluates the count on EVERY tick (live, not a snapshot at start)', () => {
    const sent: Array<{ sentinel?: { conversationCount: number } }> = []
    let conversations = 1
    const r = reporter({
      conversationCount: () => conversations,
      send: frame => {
        sent.push(frame as { sentinel?: { conversationCount: number } })
        return true
      },
    })
    conversations = 9
    r.tick()
    r.stop()
    expect(sent[0].sentinel?.conversationCount).toBe(1)
    expect(sent[1].sentinel?.conversationCount).toBe(9)
  })

  it('reports "not sent" without throwing when the socket is closed', () => {
    const logs: string[] = []
    reporter({ send: () => false, log: m => logs.push(m) }).stop()
    expect(logs.some(l => l.includes('send refused'))).toBe(true)
  })

  it('does not read the profile registry at all', () => {
    // Structural: the sentinel sender has no profile dependency to leak through.
    const source = require('node:fs').readFileSync(`${import.meta.dirname}/node-stats.ts`, 'utf8')
    expect(source).not.toContain('ProfileUsageSnapshot')
    expect(source).not.toContain('profileUsage')
  })
})
