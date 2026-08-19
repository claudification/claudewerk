/**
 * The ONE sampler both senders use. These run against the real host, so they
 * assert INVARIANTS (ranges, relationships) rather than values.
 */

import { describe, expect, it } from 'bun:test'
import { hostname } from 'node:os'
import { createMachineSampler, readNodeIdentity } from './node-stats-sampler'
import { validateNodeStats } from './node-stats-validate'

describe('machine sampler', () => {
  it('produces a block that passes the shared validator', () => {
    const machine = createMachineSampler().sample()
    const frame = {
      type: 'report_node_stats',
      ...readNodeIdentity('n1', 'abc1234'),
      sampledAt: Date.now(),
      machine,
    }
    expect(validateNodeStats(frame).ok).toBe(true)
  })

  it('reports 0% cpu on the FIRST sample -- one reading of a counter carries no rate', () => {
    expect(createMachineSampler().sample().cpuPercent).toBe(0)
  })

  it('reports a real 0-100 cpu percent on the second sample', async () => {
    const sampler = createMachineSampler()
    sampler.sample()
    await Bun.sleep(30)
    const cpu = sampler.sample().cpuPercent
    expect(cpu).toBeGreaterThanOrEqual(0)
    expect(cpu).toBeLessThanOrEqual(100)
    expect(Number.isFinite(cpu)).toBe(true)
  })

  it('memory used never exceeds total, and total is non-zero', () => {
    const { memory } = createMachineSampler().sample()
    expect(memory.totalBytes).toBeGreaterThan(0)
    expect(memory.usedBytes).toBeLessThanOrEqual(memory.totalBytes)
    expect(memory.usedBytes).toBeGreaterThan(0)
  })

  it('disk used never exceeds total for the volume it measures', () => {
    const { disk } = createMachineSampler().sample()
    expect(disk.totalBytes).toBeGreaterThan(0)
    expect(disk.usedBytes).toBeLessThanOrEqual(disk.totalBytes)
    expect(disk.mount).toBe(process.cwd())
  })

  it('measures the volume it is pointed at', () => {
    expect(createMachineSampler('/').sample().disk.mount).toBe('/')
  })

  it('an unreadable mount yields zeros, not a dropped sample -- cpu is still live', () => {
    const machine = createMachineSampler('/no/such/volume/anywhere').sample()
    expect(machine.disk.totalBytes).toBe(0)
    expect(machine.disk.usedBytes).toBe(0)
    expect(machine.memory.totalBytes).toBeGreaterThan(0)
  })

  it('load average carries the core count needed to read it', () => {
    const { load } = createMachineSampler().sample()
    expect(load.cores).toBeGreaterThanOrEqual(1)
    expect(load.avg1).toBeGreaterThanOrEqual(0)
  })
})

describe('node identity', () => {
  it('labels by the real hostname and an os/arch platform string', () => {
    const identity = readNodeIdentity('n1', 'abc1234')
    expect(identity.nodeId).toBe('n1')
    expect(identity.hostname).toBe(hostname())
    expect(identity.platform).toMatch(/^[a-z0-9]+\/[a-z0-9]+$/)
    expect(identity.agentVersion).toBe('abc1234')
    expect(Number.isInteger(identity.uptimeSec)).toBe(true)
    expect(identity.uptimeSec).toBeGreaterThan(0)
  })
})
