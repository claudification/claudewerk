import { describe, expect, it } from 'bun:test'
import { type LessonsScavengerDeps, msUntilNextHour, scavengeOnce } from './lessons-scavenger'

const NOW = 1_700_000_000_000

function makeDeps(over: Partial<LessonsScavengerDeps> = {}): {
  deps: LessonsScavengerDeps
  started: string[]
  marked: Array<[string, number]>
  logs: string[]
} {
  const started: string[] = []
  const marked: Array<[string, number]> = []
  const logs: string[] = []
  const deps: LessonsScavengerDeps = {
    now: () => NOW,
    log: m => logs.push(m),
    listProjectUris: () => ['claude://default/a', 'claude://default/b', 'claude://default/c'],
    isEnabled: uri => uri !== 'claude://default/c', // c is opted out
    hasActivitySince: uri => uri !== 'claude://default/b', // b is idle
    startLessons: async uri => {
      started.push(uri)
      return { recapId: `recap_${uri.slice(-1)}`, cached: false }
    },
    markRun: (uri, ts) => marked.push([uri, ts]),
    ...over,
  }
  return { deps, started, marked, logs }
}

describe('scavengeOnce', () => {
  it('runs only enabled + active projects, skips opted-out and idle', async () => {
    const { deps, started, marked } = makeDeps()
    const res = await scavengeOnce(deps)
    expect(res).toEqual({ considered: 3, enabled: 2, skippedIdle: 1, started: 1, cached: 0, failed: 0 })
    // only project a (enabled + active) starts
    expect(started).toEqual(['claude://default/a'])
    expect(marked).toEqual([['claude://default/a', NOW]])
  })

  it('uses the windowDays lookback for the activity gate', async () => {
    const seen: number[] = []
    const { deps } = makeDeps({
      windowDays: 14,
      hasActivitySince: (_uri, since) => {
        seen.push(since)
        return true
      },
      isEnabled: () => true,
    })
    await scavengeOnce(deps)
    expect(seen.every(s => s === NOW - 14 * 24 * 60 * 60 * 1000)).toBe(true)
  })

  it('counts cached runs separately and still marks the run', async () => {
    const { deps, marked } = makeDeps({
      isEnabled: () => true,
      hasActivitySince: () => true,
      startLessons: async uri => ({ recapId: `r_${uri.slice(-1)}`, cached: true }),
    })
    const res = await scavengeOnce(deps)
    expect(res.started).toBe(3)
    expect(res.cached).toBe(3)
    expect(marked).toHaveLength(3)
  })

  it('does not abort the pass when one project throws', async () => {
    const { deps, started } = makeDeps({
      isEnabled: () => true,
      hasActivitySince: () => true,
      startLessons: async uri => {
        if (uri.endsWith('b')) throw new Error('boom')
        started.push(uri)
        return { recapId: 'r', cached: false }
      },
    })
    const res = await scavengeOnce(deps)
    expect(res.failed).toBe(1)
    expect(res.started).toBe(2)
    expect(started).toEqual(['claude://default/a', 'claude://default/c'])
  })
})

describe('msUntilNextHour', () => {
  it('returns time to the next local hour today when it is still ahead', () => {
    const base = new Date(2026, 5, 22, 1, 0, 0, 0).getTime() // 01:00 local
    const ms = msUntilNextHour(4, base)
    expect(ms).toBe(3 * 60 * 60 * 1000) // 3h to 04:00
  })

  it('rolls to tomorrow when the hour has already passed', () => {
    const base = new Date(2026, 5, 22, 6, 0, 0, 0).getTime() // 06:00 local, target 04:00
    const ms = msUntilNextHour(4, base)
    expect(ms).toBe(22 * 60 * 60 * 1000) // 22h to next 04:00
  })

  it('is always strictly positive (never schedules in the past)', () => {
    const base = new Date(2026, 5, 22, 4, 0, 0, 0).getTime() // exactly 04:00
    expect(msUntilNextHour(4, base)).toBe(24 * 60 * 60 * 1000)
  })
})
