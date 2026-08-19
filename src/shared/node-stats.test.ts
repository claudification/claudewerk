import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanSourceFiles } from '../../scripts/lib/source-files'
import {
  dedupeMachineStatsByHost,
  isNodeStatsStale,
  type MachineStats,
  NODE_STATS_INTERVAL_MS,
  NODE_STATS_STALE_AFTER_MS,
  type NodeStatsReport,
  type NodeStatsSender,
  validateNodeStats,
} from './node-stats'

const ROOT = join(import.meta.dir, '..', '..')

const MACHINE: MachineStats = {
  cpuPercent: 41.5,
  load: { one: 3.2, five: 2.8, fifteen: 2.1, cores: 12 },
  memory: { usedBytes: 24_000_000_000, totalBytes: 64_000_000_000 },
  disk: { usedBytes: 1_900_000_000_000, totalBytes: 2_000_000_000_000, mount: '/' },
}

function frame(over: Partial<NodeStatsReport> = {}, sender: NodeStatsSender = 'sentinel'): NodeStatsReport {
  return {
    type: 'node_stats',
    node: {
      nodeId: 'snt_studio',
      hostId: 'host_studio',
      hostname: 'studio',
      osArch: 'darwin/arm64',
      agentVersion: '1.2.3',
      uptimeSec: 86_400,
      sender,
    },
    machine: MACHINE,
    sampledAt: 1_700_000_000_000,
    ...over,
  }
}

/** A reporter frame: same builder, no extras. */
function reporterFrame(over: Partial<NodeStatsReport> = {}): NodeStatsReport {
  const base = frame(over, 'reporter')
  base.node.nodeId = 'rpt_nas'
  return base
}

describe('node-stats cadence', () => {
  it('is a shared constant, one sample every 5s', () => {
    expect(NODE_STATS_INTERVAL_MS).toBe(5_000)
  })

  it('derives the staleness window from the cadence, not a second magic number', () => {
    expect(NODE_STATS_STALE_AFTER_MS).toBe(NODE_STATS_INTERVAL_MS * 3)
  })

  it('marks a node stale only after it misses several ticks', () => {
    const report = frame()
    expect(isNodeStatsStale(report, report.sampledAt + NODE_STATS_INTERVAL_MS)).toBe(false)
    expect(isNodeStatsStale(report, report.sampledAt + NODE_STATS_STALE_AFTER_MS)).toBe(false)
    expect(isNodeStatsStale(report, report.sampledAt + NODE_STATS_STALE_AFTER_MS + 1)).toBe(true)
  })
})

describe('validateNodeStats -- schema round-trip', () => {
  it('accepts a sentinel frame through JSON and back unchanged', () => {
    const sent = frame({ sentinel: { conversationCount: 7 } })
    const wire = JSON.parse(JSON.stringify(sent))
    const result = validateNodeStats(wire)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.errors.join(', '))
    expect(result.report).toEqual(sent)
  })

  it('accepts a REPORTER frame through the exact same validator', () => {
    const wire = JSON.parse(JSON.stringify(reporterFrame()))
    const result = validateNodeStats(wire)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.errors.join(', '))
    expect(result.report).toEqual(reporterFrame())
  })

  it('rejects a non-object and a wrong type literal', () => {
    expect(validateNodeStats(null).ok).toBe(false)
    expect(validateNodeStats('node_stats').ok).toBe(false)
    const wrong = validateNodeStats({ ...frame(), type: 'sentinel_usage_report' })
    expect(wrong.ok).toBe(false)
    if (wrong.ok) throw new Error('expected rejection')
    expect(wrong.errors.join(' ')).toContain('node_stats')
  })

  it('names every missing identity field rather than failing on the first', () => {
    const result = validateNodeStats({ ...frame(), node: {} })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    for (const field of ['nodeId', 'hostId', 'hostname', 'osArch', 'agentVersion', 'uptimeSec', 'sender']) {
      expect(result.errors.join(' ')).toContain(`node.${field}`)
    }
  })

  it('rejects an unknown sender', () => {
    const bad = frame()
    const result = validateNodeStats({ ...bad, node: { ...bad.node, sender: 'broker' } })
    expect(result.ok).toBe(false)
  })

  it('rejects impossible machine numbers', () => {
    expect(validateNodeStats({ ...frame(), machine: { ...MACHINE, cpuPercent: 140 } }).ok).toBe(false)
    expect(validateNodeStats({ ...frame(), machine: { ...MACHINE, cpuPercent: Number.NaN } }).ok).toBe(false)
    expect(
      validateNodeStats({
        ...frame(),
        machine: { ...MACHINE, memory: { usedBytes: 9, totalBytes: 4 } },
      }).ok,
    ).toBe(false)
    expect(
      validateNodeStats({
        ...frame(),
        machine: { ...MACHINE, load: { one: 1, five: 1, fifteen: 1, cores: 0 } },
      }).ok,
    ).toBe(false)
    expect(
      validateNodeStats({
        ...frame(),
        machine: { ...MACHINE, disk: { usedBytes: 1, totalBytes: 2, mount: '' } },
      }).ok,
    ).toBe(false)
  })

  it('rejects a missing or non-positive sampledAt', () => {
    expect(validateNodeStats({ ...frame(), sampledAt: 0 }).ok).toBe(false)
    const { sampledAt: _drop, ...noStamp } = frame()
    expect(validateNodeStats(noStamp).ok).toBe(false)
  })
})

describe('validateNodeStats -- sentinel-only extras', () => {
  it('accepts the conversation count on a sentinel frame', () => {
    const result = validateNodeStats(frame({ sentinel: { conversationCount: 0 } }))
    expect(result.ok).toBe(true)
  })

  it('accepts a sentinel frame with the extras absent entirely', () => {
    expect(validateNodeStats(frame()).ok).toBe(true)
    expect(frame().sentinel).toBeUndefined()
  })

  it('a reporter frame carries NO extras key at all -- absent, not zero', () => {
    const wire = JSON.parse(JSON.stringify(reporterFrame()))
    expect('sentinel' in wire).toBe(false)
  })

  it('REJECTS sentinel-only extras smuggled onto a reporter frame', () => {
    const result = validateNodeStats({ ...reporterFrame(), sentinel: { conversationCount: 3 } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.errors.join(' ')).toContain('reporter frame')
  })

  it('rejects a malformed conversation count on a sentinel frame', () => {
    expect(validateNodeStats({ ...frame(), sentinel: { conversationCount: -1 } }).ok).toBe(false)
    expect(validateNodeStats({ ...frame(), sentinel: {} }).ok).toBe(false)
  })
})

describe('dedupeMachineStatsByHost', () => {
  const sentinelOnStudio = frame({ sampledAt: 1_000, sentinel: { conversationCount: 4 } })
  const reporterOnStudio = reporterFrame({ sampledAt: 2_000 })
  reporterOnStudio.node.hostId = 'host_studio'
  reporterOnStudio.node.hostname = 'studio'
  reporterOnStudio.machine = { ...MACHINE, cpuPercent: 12 }

  it('counts one box once even with two agents on it', () => {
    const rows = dedupeMachineStatsByHost([sentinelOnStudio, reporterOnStudio])
    expect(rows.length).toBe(1)
    expect(rows[0].hostId).toBe('host_studio')
    expect(rows[0].nodeIds).toEqual(['rpt_nas', 'snt_studio'])
  })

  it('keeps the FRESHEST sample for the host', () => {
    const rows = dedupeMachineStatsByHost([sentinelOnStudio, reporterOnStudio])
    expect(rows[0].machine.cpuPercent).toBe(12)
    expect(rows[0].reportedBy).toBe('rpt_nas')
    expect(rows[0].sampledAt).toBe(2_000)
  })

  it('does not depend on arrival order', () => {
    const forward = dedupeMachineStatsByHost([sentinelOnStudio, reporterOnStudio])
    const reverse = dedupeMachineStatsByHost([reporterOnStudio, sentinelOnStudio])
    expect(reverse).toEqual(forward)
  })

  it('breaks a same-timestamp tie deterministically, both orders', () => {
    const a = frame({ sampledAt: 5_000 })
    a.node.nodeId = 'a_node'
    a.machine = { ...MACHINE, cpuPercent: 1 }
    const b = frame({ sampledAt: 5_000 })
    b.node.nodeId = 'b_node'
    b.machine = { ...MACHINE, cpuPercent: 2 }
    expect(dedupeMachineStatsByHost([a, b])[0].reportedBy).toBe('a_node')
    expect(dedupeMachineStatsByHost([b, a])[0].reportedBy).toBe('a_node')
  })

  it('keys by hostId, not hostname -- two boxes may both be called studio', () => {
    const other = frame({ sampledAt: 3_000 })
    other.node.nodeId = 'snt_other'
    other.node.hostId = 'host_other'
    other.node.hostname = 'studio'
    const rows = dedupeMachineStatsByHost([sentinelOnStudio, other])
    expect(rows.map(r => r.hostId)).toEqual(['host_other', 'host_studio'])
  })

  it('is empty for no reports', () => {
    expect(dedupeMachineStatsByHost([])).toEqual([])
  })
})

describe('one contract, one utilization path', () => {
  const contractSources = ['src/shared/node-stats.ts', 'src/shared/node-stats-sample.ts']

  // RESOLVED 2026-08-19. This test previously banned the word `utilization` from
  // the contract outright, on the rule "plan windows ride sentinel_usage_report,
  // a second path here is duplication".
  //
  // The CARD (`node-stats-contract`) asks for the opposite in as many words:
  // "Sentinel-only extras ... running conversation count, profile NAMES with
  // plan utilization". Both cannot hold, so the rule is narrowed rather than
  // dropped: what is forbidden is a second copy of the WINDOW DATA (the reset
  // times, the per-window breakdown, the error states). `ProfileUsageSnapshot`
  // remains the single SOURCE of those. What the payload may carry is the one
  // DERIVED headline number per profile, so the wall can render a node row
  // without joining against a separately-timed second message.
  //
  // (The old assertion would not have caught this anyway: `\butilization\b` does
  // not match `utilizationPercent`, so it passed on a word-boundary accident.
  // Encoding the real rule is the point.)
  it('carries no WINDOW data -- ProfileUsageSnapshot stays the source for that', () => {
    const banned = /\b(fiveHour|sevenDay|sevenDayOpus|sevenDaySonnet|resetAt|planUsage|usageWindow|extraUsage)\b/i
    for (const rel of contractSources) {
      const code = readFileSync(join(ROOT, rel), 'utf8')
      // Strip block comments -- the prose deliberately NAMES the other path.
      const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect({ rel, hit: banned.test(withoutComments) }).toEqual({ rel, hit: false })
    }
  })

  it('carries at most ONE derived number per profile, and its NAME', () => {
    // The whole permitted profile surface, pinned. Anything else on a profile
    // entry -- a window, a reset time, a configDir -- is rejected by the
    // validator, so widening this shape cannot happen quietly.
    const parsed = validateNodeStats(
      frame({
        sentinel: {
          conversationCount: 1,
          // Deliberately invalid: a window field is exactly what must not ride here.
          profiles: [{ name: 'work', utilizationPercent: 50, sevenDay: { usedPercent: 50 } }],
        },
      } as unknown as Partial<NodeStatsReport>),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors.some(e => e.includes('sevenDay: not allowed'))).toBe(true)
  })

  it('declares the node_stats wire shape exactly once in the tree', () => {
    const decls: string[] = []
    for (const rel of scanSourceFiles(join(ROOT, 'src'), '**/*.ts')) {
      const code = readFileSync(join(ROOT, 'src', rel), 'utf8')
      // An interface/type block that pins the discriminant to 'node_stats'.
      if (/^\s*type\??:\s*'node_stats'/m.test(code)) decls.push(`src/${rel}`)
    }
    expect(decls.filter(f => !f.endsWith('.test.ts'))).toEqual(['src/shared/node-stats.ts'])
  })

  it('leaves ProfileUsageSnapshot as the single utilization carrier', () => {
    const carriers: string[] = []
    for (const rel of scanSourceFiles(join(ROOT, 'src'), '**/*.ts')) {
      const code = readFileSync(join(ROOT, 'src', rel), 'utf8')
      if (/^export interface ProfileUsageSnapshot\b/m.test(code)) carriers.push(`src/${rel}`)
    }
    expect(carriers).toEqual(['src/shared/protocol.ts'])
  })
})
