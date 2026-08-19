import { describe, expect, it } from 'bun:test'
import { validateNodeStats } from './node-stats'
import {
  buildNodeIdentity,
  buildNodeStatsReport,
  cpuPercentFromDelta,
  cpuTotals,
  createMachineSampler,
  osArchLabel,
  parseDfOutput,
} from './node-stats-sample'

function times(user: number, nice: number, sys: number, idle: number, irq: number) {
  return { times: { user, nice, sys, idle, irq } }
}

describe('cpuTotals', () => {
  it('sums every core into one whole-box pair', () => {
    expect(cpuTotals([times(10, 0, 5, 85, 0), times(20, 0, 10, 70, 0)])).toEqual({ idle: 155, total: 200 })
  })

  it('is zero for no cores rather than throwing', () => {
    expect(cpuTotals([])).toEqual({ idle: 0, total: 0 })
  })
})

describe('cpuPercentFromDelta', () => {
  it('reports busy time over the interval, not since boot', () => {
    // 100 jiffies elapsed, 25 of them idle -> 75% busy.
    expect(cpuPercentFromDelta({ idle: 1000, total: 2000 }, { idle: 1025, total: 2100 })).toBe(75)
  })

  it('returns 0 when no time elapsed instead of dividing by zero', () => {
    expect(cpuPercentFromDelta({ idle: 1000, total: 2000 }, { idle: 1000, total: 2000 })).toBe(0)
  })

  it('never leaves 0..100, so the meter never has to clamp', () => {
    expect(cpuPercentFromDelta({ idle: 0, total: 0 }, { idle: 0, total: 100 })).toBe(100)
    expect(cpuPercentFromDelta({ idle: 0, total: 0 }, { idle: 200, total: 100 })).toBe(0)
  })

  it('rounds to one decimal', () => {
    expect(cpuPercentFromDelta({ idle: 0, total: 0 }, { idle: 1, total: 3 })).toBe(66.7)
  })
})

describe('parseDfOutput', () => {
  const DARWIN = [
    'Filesystem 1024-blocks      Used Available Capacity  Mounted on',
    '/dev/disk3s1s1 1942700360 1893184216  40374144    98%    /',
  ].join('\n')

  it('reads used/total bytes and the mount point', () => {
    expect(parseDfOutput(DARWIN)).toEqual({
      usedBytes: 1_893_184_216 * 1024,
      totalBytes: 1_942_700_360 * 1024,
      mount: '/',
    })
  })

  it('handles a mount path containing spaces', () => {
    const out = [
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      '/dev/disk5 100 40 60 40% /Volumes/Big Disk',
    ].join('\n')
    expect(parseDfOutput(out)?.mount).toBe('/Volumes/Big Disk')
  })

  it('returns null on truncated or unparseable output rather than a fake zero', () => {
    expect(parseDfOutput('')).toBeNull()
    expect(parseDfOutput('Filesystem 1024-blocks Used Available Capacity Mounted on')).toBeNull()
    expect(parseDfOutput('header\n/dev/disk5 100 40')).toBeNull()
    expect(parseDfOutput('header\n/dev/disk5 lots some more 40% /')).toBeNull()
  })
})

describe('osArchLabel', () => {
  it('is a single platform/arch string', () => {
    expect(osArchLabel()).toMatch(/^[a-z0-9]+\/[a-z0-9_]+$/)
  })
})

describe('buildNodeStatsReport -- one builder, two senders', () => {
  const sentinelIdentity = buildNodeIdentity({
    nodeId: 'snt_studio',
    hostId: 'host_studio',
    agentVersion: '1.2.3',
    sender: 'sentinel',
    hostname: 'studio',
  })
  const reporterIdentity = buildNodeIdentity({
    nodeId: 'rpt_nas',
    hostId: 'host_nas',
    agentVersion: '1.2.3',
    sender: 'reporter',
    hostname: 'nas',
  })
  const machine = createMachineSampler().sample()

  it('produces a sentinel frame that validates, extras included', () => {
    const report = buildNodeStatsReport(sentinelIdentity, machine, 1_700_000_000_000, { conversationCount: 5 })
    expect(report.sentinel).toEqual({ conversationCount: 5 })
    expect(validateNodeStats(report).ok).toBe(true)
  })

  it('produces a reporter frame that validates against the SAME schema', () => {
    const report = buildNodeStatsReport(reporterIdentity, machine, 1_700_000_000_000)
    expect(validateNodeStats(report).ok).toBe(true)
    expect('sentinel' in report).toBe(false)
  })

  it('drops sentinel-only extras handed to it on a reporter frame', () => {
    const report = buildNodeStatsReport(reporterIdentity, machine, 1_700_000_000_000, { conversationCount: 9 })
    expect('sentinel' in report).toBe(false)
    expect(validateNodeStats(report).ok).toBe(true)
  })

  it('reports HOST uptime, not process uptime', () => {
    // The agent started seconds ago; the box did not.
    expect(sentinelIdentity.uptimeSec).toBeGreaterThan(process.uptime())
  })
})

describe('createMachineSampler', () => {
  it('samples real machine facts that pass the contract validator', () => {
    const sampler = createMachineSampler()
    const machine = sampler.sample()
    expect(machine.load.cores).toBeGreaterThan(0)
    expect(machine.memory.totalBytes).toBeGreaterThan(0)
    expect(machine.memory.usedBytes).toBeLessThanOrEqual(machine.memory.totalBytes)
    expect(machine.disk.mount.length).toBeGreaterThan(0)
    const identity = buildNodeIdentity({
      nodeId: 'snt_local',
      hostId: 'host_local',
      agentVersion: '0.0.0-test',
      sender: 'sentinel',
    })
    expect(validateNodeStats(buildNodeStatsReport(identity, machine, Date.now())).ok).toBe(true)
  })

  it('measures the volume it was pointed at', () => {
    const machine = createMachineSampler(process.cwd()).sample()
    expect(machine.disk.totalBytes).toBeGreaterThan(0)
  })
})
