/**
 * Card `node-stats-contract`, "Done means" lines 1-4:
 *   - One shared module both senders import; neither defines its own shape
 *   - Cadence is a shared constant
 *   - A reporter payload validates against the SAME schema as a sentinel one
 *   - Tests: schema round-trip, optional-extras absent for reporter
 * (host dedupe is proved in broker/node-stats-store.test.ts)
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NODE_STATS_INTERVAL_MS, NODE_STATS_STALE_MS } from './node-stats'
import {
  FIXTURE_MACHINE as MACHINE,
  FIXTURE_REPORTER_FRAME as REPORTER_FRAME,
  FIXTURE_SENTINEL_FRAME as SENTINEL_FRAME,
} from './node-stats-fixture'
import { validateNodeStats } from './node-stats-validate'

const SRC = join(import.meta.dirname, '..')

describe('node-stats contract: ONE shape, ONE cadence', () => {
  it('the cadence is a shared constant, not a per-sender number', () => {
    expect(NODE_STATS_INTERVAL_MS).toBe(5000)
    expect(NODE_STATS_STALE_MS).toBe(NODE_STATS_INTERVAL_MS * 3)
  })

  it('NEITHER sender declares an interval of its own', () => {
    // The rule is structural, so the test is structural: a sender that hard-codes
    // its own cadence, or its own `type: 'report_node_stats'` literal, has forked
    // the contract even if every field still happens to line up.
    for (const sender of ['sentinel/node-stats.ts', 'node-stats-reporter/index.ts']) {
      const source = readFileSync(join(SRC, sender), 'utf8')
      expect(source).toContain("from '../shared/node-stats")
      expect(source).not.toMatch(/setInterval\s*\(/)
      expect(source).not.toMatch(/type:\s*'report_node_stats'/)
    }
  })

  it('both senders route through the ONE cadence runner', () => {
    const sentinel = readFileSync(join(SRC, 'sentinel/node-stats.ts'), 'utf8')
    const reporter = readFileSync(join(SRC, 'node-stats-reporter/index.ts'), 'utf8')
    expect(sentinel).toContain('createNodeStatsReporter')
    expect(reporter).toContain('createNodeStatsReporter')
  })
})

describe('node-stats contract: one schema, two senders', () => {
  it('round-trips a sentinel frame through JSON unchanged', () => {
    const parsed = validateNodeStats(JSON.parse(JSON.stringify(SENTINEL_FRAME)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toEqual(SENTINEL_FRAME)
  })

  it('validates a REPORTER payload against the SAME schema', () => {
    const parsed = validateNodeStats(JSON.parse(JSON.stringify(REPORTER_FRAME)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toEqual(REPORTER_FRAME)
  })

  it('optional sentinel-only extras are ABSENT from a reporter frame', () => {
    const parsed = validateNodeStats(REPORTER_FRAME)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.sentinel).toBeUndefined()
    expect('sentinel' in parsed.value).toBe(false)
  })

  it('the two frames differ ONLY by the optional sentinel block', () => {
    const { sentinel, nodeId: _s, ...sentinelRest } = SENTINEL_FRAME
    const { nodeId: _r, ...reporterRest } = REPORTER_FRAME
    expect(sentinelRest).toEqual(reporterRest)
    expect(sentinel).toBeDefined()
  })
})

describe('node-stats contract: PROFILE-ENV BOUNDARY', () => {
  it('drops configDir / env / oauth tokens smuggled into a profile entry', () => {
    const hostile = {
      ...SENTINEL_FRAME,
      sentinel: {
        conversationCount: 1,
        profiles: [
          {
            name: 'work',
            utilizationPercent: 50,
            configDir: '/Users/jonas/.claude-work',
            env: { ANTHROPIC_API_KEY: 'sk-ant-secret' },
            oauthToken: 'oat_leak',
          },
        ],
      },
    }
    const parsed = validateNodeStats(hostile)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.sentinel?.profiles[0]).toEqual({ name: 'work', utilizationPercent: 50 })
    expect(JSON.stringify(parsed.value)).not.toContain('sk-ant-secret')
    expect(JSON.stringify(parsed.value)).not.toContain('.claude-work')
    expect(JSON.stringify(parsed.value)).not.toContain('oat_leak')
  })

  it('drops unknown top-level keys instead of passing them through', () => {
    const parsed = validateNodeStats({ ...REPORTER_FRAME, oauthToken: 'oat_leak', configDir: '/etc/secrets' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(JSON.stringify(parsed.value)).not.toContain('oat_leak')
    expect(JSON.stringify(parsed.value)).not.toContain('/etc/secrets')
  })

  it('clamps a utilization percent to 0-100', () => {
    const parsed = validateNodeStats({
      ...SENTINEL_FRAME,
      sentinel: { conversationCount: 0, profiles: [{ name: 'a', utilizationPercent: 400 }] },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.sentinel?.profiles[0].utilizationPercent).toBe(100)
  })
})

describe('node-stats contract: rejections', () => {
  const cases: Array<[string, unknown]> = [
    ['not an object', 'nope'],
    ['wrong type literal', { ...REPORTER_FRAME, type: 'heartbeat' }],
    ['missing nodeId', { ...REPORTER_FRAME, nodeId: '  ' }],
    ['missing hostname', { ...REPORTER_FRAME, hostname: undefined }],
    ['missing machine block', { ...REPORTER_FRAME, machine: undefined }],
    [
      'machine missing disk mount',
      { ...REPORTER_FRAME, machine: { ...MACHINE, disk: { usedBytes: 1, totalBytes: 2 } } },
    ],
    ['negative uptime', { ...REPORTER_FRAME, uptimeSec: -1 }],
    ['zero sampledAt', { ...REPORTER_FRAME, sampledAt: 0 }],
    ['NaN cpu', { ...REPORTER_FRAME, machine: { ...MACHINE, cpuPercent: Number.NaN } }],
    ['zero cores', { ...REPORTER_FRAME, machine: { ...MACHINE, load: { avg1: 1, avg5: 1, avg15: 1, cores: 0 } } }],
  ]

  for (const [name, payload] of cases) {
    it(`rejects: ${name}`, () => {
      const parsed = validateNodeStats(payload)
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.error.length).toBeGreaterThan(0)
    })
  }
})
