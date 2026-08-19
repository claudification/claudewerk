import { describe, expect, it } from 'bun:test'
import { validateNodeStats } from './node-stats'
import {
  buildNodeIdentity,
  buildNodeStatsReport,
  cpuPercentFromDelta,
  cpuTotals,
  createMachineSampler,
  osArchLabel,
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

describe('disk read: statfs, not a fork', () => {
  it('reads the real volume with used <= total', () => {
    const { disk } = createMachineSampler(process.cwd()).sample()
    expect(disk.totalBytes).toBeGreaterThan(0)
    expect(disk.usedBytes).toBeGreaterThanOrEqual(0)
    expect(disk.usedBytes).toBeLessThanOrEqual(disk.totalBytes)
  })

  it('reports the mount it was asked about', () => {
    expect(createMachineSampler('/').sample().disk.mount).toBe('/')
  })

  it('an unreadable path yields a zeroed disk, NOT a dropped frame -- cpu is still live', () => {
    const machine = createMachineSampler('/no/such/volume/anywhere').sample()
    expect(machine.disk).toEqual({ usedBytes: 0, totalBytes: 0, mount: '/no/such/volume/anywhere' })
    expect(machine.memory.totalBytes).toBeGreaterThan(0)
  })

  it('counts space this agent can actually WRITE (bavail), not root-reserved blocks', () => {
    // A meter that says 5% free while every write fails is a broken meter, so
    // used is computed against the unprivileged-available figure. That makes
    // used+free <= total on a reserved filesystem; it must never exceed total.
    const { disk } = createMachineSampler('/').sample()
    expect(disk.usedBytes).toBeLessThanOrEqual(disk.totalBytes)
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
