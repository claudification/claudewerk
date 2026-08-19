/**
 * The ONE cadence runner both senders start. Split out of node-stats.test.ts
 * (schema + shape) to keep each file under the 200-line bar.
 */

import { describe, expect, it } from 'bun:test'
import { REPORT_NODE_STATS, type ReportNodeStats } from './node-stats'
import { stubSampler } from './node-stats-fixture'
import { buildNodeStatsFrame, createNodeStatsReporter } from './node-stats-reporting'
import { validateNodeStats } from './node-stats-validate'

describe('node-stats cadence runner', () => {
  it('builds a reporter frame with no sentinel block when no extras callback is given', () => {
    const frame = buildNodeStatsFrame({ nodeId: 'n1', agentVersion: 'v1' }, stubSampler, 123)
    expect(frame.type).toBe(REPORT_NODE_STATS)
    expect(frame.sentinel).toBeUndefined()
    expect(validateNodeStats(frame).ok).toBe(true)
  })

  it('builds a sentinel frame with the extras block when the callback is given', () => {
    const frame = buildNodeStatsFrame(
      { nodeId: 'n1', agentVersion: 'v1', sentinelExtras: () => ({ conversationCount: 3, profiles: [{ name: 'x' }] }) },
      stubSampler,
      123,
    )
    expect(frame.sentinel).toEqual({ conversationCount: 3, profiles: [{ name: 'x' }] })
    expect(validateNodeStats(frame).ok).toBe(true)
  })

  it('emits one frame immediately on start, then on the cadence', async () => {
    const sent: ReportNodeStats[] = []
    const reporter = createNodeStatsReporter({
      nodeId: 'n1',
      agentVersion: 'v1',
      sampler: stubSampler,
      intervalMs: 5,
      send: frame => {
        sent.push(frame)
      },
    })
    reporter.start()
    expect(sent.length).toBe(1) // immediate: a fresh node shows up without a wait
    await Bun.sleep(18)
    reporter.stop()
    const afterStop = sent.length
    expect(afterStop).toBeGreaterThan(1)
    await Bun.sleep(15)
    expect(sent.length).toBe(afterStop) // stop() actually stops
  })

  it('start() twice does not stack two timers', async () => {
    let calls = 0
    const reporter = createNodeStatsReporter({
      nodeId: 'n1',
      agentVersion: 'v1',
      sampler: stubSampler,
      intervalMs: 5,
      send: () => {
        calls++
      },
    })
    reporter.start()
    reporter.start() // a reconnect path that double-starts must not double the rate
    const afterStarts = calls
    await Bun.sleep(18)
    reporter.stop()
    // Two immediate ticks would mean two timers; one start = one immediate tick.
    expect(afterStarts).toBe(1)
  })

  it('logs and keeps its cadence when a send throws', async () => {
    const logs: string[] = []
    let calls = 0
    const reporter = createNodeStatsReporter({
      nodeId: 'n1',
      agentVersion: 'v1',
      sampler: stubSampler,
      intervalMs: 5,
      send: () => {
        calls++
        if (calls === 1) throw new Error('socket closed')
        return true
      },
      log: message => logs.push(message),
    })
    reporter.start()
    await Bun.sleep(18)
    reporter.stop()
    expect(logs.some(l => l.includes('send failed'))).toBe(true)
    expect(calls).toBeGreaterThan(1) // a failed tick does not kill the cadence
  })

  it('treats an explicit false return as "not sent" and logs it', () => {
    const logs: string[] = []
    const reporter = createNodeStatsReporter({
      nodeId: 'n1',
      agentVersion: 'v1',
      sampler: stubSampler,
      send: () => false,
      log: message => logs.push(message),
    })
    expect(reporter.tick()).toBeNull()
    expect(logs.some(l => l.includes('send refused'))).toBe(true)
  })

  it('survives a throwing sampler without killing the cadence', () => {
    const logs: string[] = []
    const reporter = createNodeStatsReporter({
      nodeId: 'n1',
      agentVersion: 'v1',
      sampler: {
        sample: () => {
          throw new Error('statfs exploded')
        },
      },
      send: () => true,
      log: message => logs.push(message),
    })
    expect(reporter.tick()).toBeNull()
    expect(logs.some(l => l.includes('sample failed'))).toBe(true)
  })

  it('stop() on a never-started reporter is a no-op', () => {
    const reporter = createNodeStatsReporter({
      nodeId: 'n1',
      agentVersion: 'v1',
      sampler: stubSampler,
      send: () => true,
    })
    expect(() => reporter.stop()).not.toThrow()
  })
})
