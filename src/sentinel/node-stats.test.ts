/**
 * The sentinel's OPTIONAL extras block, and the PROFILE-ENV BOUNDARY it must
 * not cross: profile NAMES and a utilization percent may travel; configDir,
 * `env` and oauth tokens never do.
 */

import { describe, expect, it } from 'bun:test'
import { validateNodeStats } from '../shared/node-stats'
import type { ProfileUsageSnapshot } from '../shared/protocol'
import { buildProfileUtilizations, profileUtilization, startSentinelNodeStats } from './node-stats'

function snap(over: Partial<ProfileUsageSnapshot> & { profile: string }): ProfileUsageSnapshot {
  return { authed: true, polledAt: 1, ...over }
}

const win = (usedPercent: number) => ({ usedPercent, resetAt: '2026-08-20T00:00:00.000Z' })

describe('profile utilization: which number we report', () => {
  it('prefers the 7-day window (the one that ends a week)', () => {
    expect(profileUtilization(snap({ profile: 'a', sevenDay: win(61), fiveHour: win(3) }))).toBe(61)
  })

  it('falls back to the 5-hour window when that is all there is', () => {
    expect(profileUtilization(snap({ profile: 'a', fiveHour: win(12) }))).toBe(12)
  })

  it('is UNDEFINED for an unauthed profile -- absent is honest, zero would read as headroom', () => {
    expect(profileUtilization(snap({ profile: 'a', authed: false }))).toBeUndefined()
  })

  it('is undefined when the poll errored', () => {
    expect(profileUtilization(snap({ profile: 'a', error: { kind: 'http', status: 429 } }))).toBeUndefined()
  })
})

describe('the broker-safe profile slice', () => {
  it('emits NAME + percent only, sorted', () => {
    const usage = new Map<string, ProfileUsageSnapshot>([
      ['work', snap({ profile: 'work', sevenDay: win(12) })],
      ['default', snap({ profile: 'default', sevenDay: win(61) })],
    ])
    expect(buildProfileUtilizations(usage)).toEqual([
      { name: 'default', utilizationPercent: 61 },
      { name: 'work', utilizationPercent: 12 },
    ])
  })

  it('an unauthed profile still gets a row, with no number', () => {
    const usage = new Map([['ghost', snap({ profile: 'ghost', authed: false })]])
    expect(buildProfileUtilizations(usage)).toEqual([{ name: 'ghost' }])
  })

  it('carries NO configDir, env or token even when the snapshot is fat', () => {
    const fat = {
      ...snap({ profile: 'work', sevenDay: win(50) }),
      configDir: '/Users/jonas/.claude-work',
      env: { ANTHROPIC_API_KEY: 'sk-ant-leak' },
    } as ProfileUsageSnapshot
    const serialised = JSON.stringify(buildProfileUtilizations(new Map([['work', fat]])))
    expect(serialised).not.toContain('sk-ant-leak')
    expect(serialised).not.toContain('.claude-work')
    expect(JSON.parse(serialised)).toEqual([{ name: 'work', utilizationPercent: 50 }])
  })

  it('an empty profile map yields an empty list, not undefined', () => {
    expect(buildProfileUtilizations(new Map())).toEqual([])
  })
})

describe('the sentinel sender', () => {
  it('emits a valid frame WITH the extras block, on the socket it is handed', () => {
    const sent: unknown[] = []
    const reporter = startSentinelNodeStats({
      nodeId: 'machine-1',
      hostId: 'host-1',
      agentVersion: 'abc1234',
      conversationCount: () => 4,
      profileUsage: () => new Map([['default', snap({ profile: 'default', sevenDay: win(61) })]]),
      send: frame => {
        sent.push(frame)
        return true
      },
      log: () => {},
    })
    reporter.stop()

    expect(sent.length).toBe(1)
    const parsed = validateNodeStats(JSON.parse(JSON.stringify(sent[0])))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.report.sentinel).toEqual({
      conversationCount: 4,
      profiles: [{ name: 'default', utilizationPercent: 61 }],
    })
    expect(parsed.report.node.sender).toBe('sentinel')
    expect(parsed.report.node.hostId).toBe('host-1')
  })

  it('re-evaluates the extras on EVERY tick (a live count, not a snapshot at start)', () => {
    const sent: Array<{ sentinel?: { conversationCount: number } }> = []
    let conversations = 1
    const reporter = startSentinelNodeStats({
      nodeId: 'machine-1',
      hostId: 'host-1',
      agentVersion: 'abc1234',
      conversationCount: () => conversations,
      profileUsage: () => new Map(),
      send: frame => {
        sent.push(frame as { sentinel?: { conversationCount: number } })
        return true
      },
      log: () => {},
    })
    conversations = 9
    reporter.tick()
    reporter.stop()
    expect(sent[0].sentinel?.conversationCount).toBe(1)
    expect(sent[1].sentinel?.conversationCount).toBe(9)
  })

  it('reports "not sent" without throwing when the socket is closed', () => {
    const logs: string[] = []
    const reporter = startSentinelNodeStats({
      nodeId: 'machine-1',
      hostId: 'host-1',
      agentVersion: 'abc1234',
      conversationCount: () => 0,
      profileUsage: () => new Map(),
      send: () => false,
      log: m => logs.push(m),
    })
    reporter.stop()
    expect(logs.some(l => l.includes('send refused'))).toBe(true)
  })
})
