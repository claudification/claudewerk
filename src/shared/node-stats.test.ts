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

  it('accepts a frame with NO cpuPercent -- absent is how "no reading" is spelled', () => {
    // The first frame after a sender starts has no CPU delta to divide (card
    // `node-stats-first-tick-is-noise`). It is a valid frame carrying real ram,
    // disk and load; the alternative was a fabricated 0 or 100 on the wire.
    const { cpuPercent: _dropped, ...noCpu } = MACHINE
    expect(validateNodeStats({ ...frame(), machine: noCpu }).ok).toBe(true)
  })

  it('still rejects a cpuPercent that is PRESENT and nonsense', () => {
    // Absent is the only legal way to say "no reading". A null, a NaN or a string
    // is a producer that fabricated something, and it fails like anything else.
    for (const cpuPercent of [null, 'unknown', Number.NaN, -1]) {
      expect(validateNodeStats({ ...frame(), machine: { ...MACHINE, cpuPercent } }).ok).toBe(false)
    }
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

  // The original rule, RESTORED and sharpened (decision 2026-08-19): plan
  // windows ride `sentinel_usage_report` / ProfileUsageSnapshot, and a second
  // path here is exactly the duplication this card exists to prevent. A derived
  // headline percent was briefly carried on the payload and has been removed --
  // one number sampled on two clocks is one number that can disagree with
  // itself.
  //
  // The old assertion could not have caught that: it banned `\butilization\b`,
  // which does NOT match `utilizationPercent`, so a field by that name sailed
  // straight through on a word-boundary accident. The substring match below is
  // the fix -- it catches any casing and any suffix.
  it('carries NO plan-utilization field, in any spelling', () => {
    const banned = /(utilization|utilisation|fiveHour|sevenDay|planUsage|usageWindow|extraUsage|usedPercent)/i
    for (const rel of contractSources) {
      const code = readFileSync(join(ROOT, rel), 'utf8')
      // Strip comments -- the prose deliberately NAMES the other path.
      const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const hit = banned.exec(withoutComments)
      expect({ rel, hit: hit?.[0] ?? null }).toEqual({ rel, hit: null })
    }
  })

  it('the extras block is conversationCount and NOTHING else', () => {
    // Held by refusal rather than trimming, so a sender that grows a `profiles`
    // array (or a configDir) is visible in the logs instead of silently ignored.
    const parsed = validateNodeStats(
      frame({
        sentinel: {
          conversationCount: 1,
          profiles: [{ name: 'work', utilizationPercent: 50 }],
        },
      } as unknown as Partial<NodeStatsReport>),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors.some(e => e.includes('sentinel.profiles: not allowed'))).toBe(true)
  })

  it('rejects a configDir smuggled onto the extras block', () => {
    const parsed = validateNodeStats(
      frame({
        sentinel: { conversationCount: 1, configDir: '/Users/jonas/.claude-work' },
      } as unknown as Partial<NodeStatsReport>),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors.some(e => e.includes('sentinel.configDir: not allowed'))).toBe(true)
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
