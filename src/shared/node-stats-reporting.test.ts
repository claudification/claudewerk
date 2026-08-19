/**
 * The ONE cadence runner both senders start.
 *
 * Card `node-stats-contract`, "Done means": one shared module both senders
 * import (neither defines its own shape), and the cadence is a shared constant.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NODE_STATS_INTERVAL_MS, NODE_STATS_MESSAGE, type NodeStatsReport, validateNodeStats } from './node-stats'
import { FIXTURE_REPORTER_IDENTITY, stubSampler } from './node-stats-fixture'
import { createNodeStatsReporter } from './node-stats-reporting'

const SRC = join(import.meta.dirname, '..')
const SENTINEL_IDENTITY = { ...FIXTURE_REPORTER_IDENTITY, nodeId: 'snt-1', sender: 'sentinel' as const }

function runner(over: Partial<Parameters<typeof createNodeStatsReporter>[0]> = {}) {
  return createNodeStatsReporter({
    identity: FIXTURE_REPORTER_IDENTITY,
    sampler: stubSampler,
    send: () => true,
    ...over,
  })
}

describe('ONE contract: neither sender forks it', () => {
  it('the cadence is a shared constant', () => {
    expect(NODE_STATS_INTERVAL_MS).toBe(5_000)
  })

  it('NEITHER sender declares an interval or a frame shape of its own', () => {
    // The rule is structural, so the test is structural: a sender that grows its
    // own `setInterval`, or hand-builds a `type: 'node_stats'` frame, has forked
    // the contract even if every field still happens to line up today.
    for (const sender of ['sentinel/node-stats.ts', 'node-stats-reporter/index.ts']) {
      const source = readFileSync(join(SRC, sender), 'utf8')
      expect(source).toContain("from '../shared/node-stats")
      expect(source).not.toMatch(/setInterval\s*\(/)
      expect(source).not.toMatch(/type:\s*'node_stats'/)
    }
  })

  it('both senders route through the ONE cadence runner and the ONE sampler', () => {
    for (const sender of ['sentinel/node-stats.ts', 'node-stats-reporter/index.ts']) {
      const source = readFileSync(join(SRC, sender), 'utf8')
      expect(source).toContain('createNodeStatsReporter')
      expect(source).toContain('buildNodeIdentity')
    }
  })

  it('both senders compute the host fingerprint with the SAME shared function', () => {
    // Two fingerprint algorithms would put one box on the wall twice.
    const sentinel = readFileSync(join(SRC, 'sentinel/index.ts'), 'utf8')
    const reporter = readFileSync(join(SRC, 'node-stats-reporter/index.ts'), 'utf8')
    expect(sentinel).toContain("from '../shared/host-id'")
    expect(reporter).toContain("from '../shared/host-id'")
  })

  it('the sampler reads disk by SYSCALL first, forking only when that fails', () => {
    // This runs every 5s on every node forever, so `df` on the common path would
    // be ~17k spawns per node per day. But statfs alone is not enough: it
    // EOVERFLOWs past 2^32 blocks and shipped disk 0/0 for a 30TB NAS array.
    // Both, in that order -- the ?? is the whole rule.
    const sampler = readFileSync(join(SRC, 'shared/node-stats-sample.ts'), 'utf8')
    expect(sampler).toMatch(/readDiskViaStatfs\(dir\)\s*\?\?\s*readDiskViaDf\(dir\)/)
  })
})

describe('node-stats cadence runner', () => {
  it('builds a reporter frame with no sentinel block when no extras callback is given', () => {
    const frame = runner().tick()
    expect(frame?.type).toBe(NODE_STATS_MESSAGE)
    expect(frame?.sentinel).toBeUndefined()
    expect(validateNodeStats(frame).ok).toBe(true)
  })

  it('builds a sentinel frame with the extras block when the callback is given', () => {
    const frame = runner({
      identity: SENTINEL_IDENTITY,
      sentinelExtras: () => ({ conversationCount: 3, profiles: [{ name: 'x' }] }),
    }).tick()
    expect(frame?.sentinel).toEqual({ conversationCount: 3, profiles: [{ name: 'x' }] })
    expect(validateNodeStats(frame).ok).toBe(true)
  })

  it('drops extras a REPORTER tries to attach -- the builder is the one gate', () => {
    const frame = runner({ sentinelExtras: () => ({ conversationCount: 99 }) }).tick()
    expect(frame?.sentinel).toBeUndefined()
  })

  it('emits one frame immediately on start, then on the cadence', async () => {
    const sent: NodeStatsReport[] = []
    const reporter = runner({ intervalMs: 5, send: f => void sent.push(f) })
    reporter.start()
    expect(sent.length).toBe(1) // immediate: a fresh node shows up without a wait
    await Bun.sleep(18)
    reporter.stop()
    const afterStop = sent.length
    expect(afterStop).toBeGreaterThan(1)
    await Bun.sleep(15)
    expect(sent.length).toBe(afterStop) // stop() actually stops
  })

  it('start() twice does not stack two timers', () => {
    let calls = 0
    const reporter = runner({ intervalMs: 5, send: () => void calls++ })
    reporter.start()
    reporter.start() // a reconnect path that double-starts must not double the rate
    expect(calls).toBe(1)
    reporter.stop()
  })

  it('logs and keeps its cadence when a send throws', async () => {
    const logs: string[] = []
    let calls = 0
    const reporter = runner({
      intervalMs: 5,
      send: () => {
        calls++
        if (calls === 1) throw new Error('socket closed')
        return true
      },
      log: m => logs.push(m),
    })
    reporter.start()
    await Bun.sleep(18)
    reporter.stop()
    expect(logs.some(l => l.includes('send failed'))).toBe(true)
    expect(calls).toBeGreaterThan(1) // a failed tick does not kill the cadence
  })

  it('treats an explicit false return as "not sent" and logs it', () => {
    const logs: string[] = []
    expect(runner({ send: () => false, log: m => logs.push(m) }).tick()).toBeNull()
    expect(logs.some(l => l.includes('send refused'))).toBe(true)
  })

  it('survives a throwing sampler without killing the cadence', () => {
    const logs: string[] = []
    const reporter = runner({
      sampler: {
        sample: () => {
          throw new Error('statfs exploded')
        },
      },
      log: m => logs.push(m),
    })
    expect(reporter.tick()).toBeNull()
    expect(logs.some(l => l.includes('sample failed'))).toBe(true)
  })

  it('stop() on a never-started reporter is a no-op', () => {
    expect(() => runner().stop()).not.toThrow()
  })
})
