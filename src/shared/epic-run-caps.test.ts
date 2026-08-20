import { describe, expect, test } from 'bun:test'
import { elapsedRunMinutes, epicRunCaps, formatEpicRunCaps, formatUsd } from './epic-run-caps'
import type { EpicRunMeta } from './epic-run-types'

const T0 = Date.parse('2026-08-21T00:00:00.000Z')
const at = (minutes: number) => T0 + minutes * 60_000

const RUN: EpicRunMeta = {
  epicId: 'e1',
  project: 'claude://s/p',
  cadence: 'now',
  status: 'running',
  gen: 3,
  target: 'merged',
  dryGens: 0,
  maxGens: 40,
  maxUsd: 100,
  maxWallClockMinutes: 480,
  spentUsd: 0,
  concurrency: 3,
  plan: false,
  planned: true,
  created: '',
  updated: '',
}

const run = (over: Partial<EpicRunMeta> = {}): EpicRunMeta => ({ ...RUN, ...over })
const byLabel = (r: EpicRunMeta, nowMs: number, label: string) => epicRunCaps(r, nowMs).find(c => c.label === label)

describe('elapsedRunMinutes', () => {
  test('is null before the clock starts -- a window run waiting for the night owes nothing', () => {
    expect(elapsedRunMinutes(run(), T0)).toBeNull()
  })

  test('counts whole minutes since startedAt', () => {
    expect(elapsedRunMinutes(run({ startedAt: '2026-08-21T00:00:00.000Z' }), at(90))).toBe(90)
  })

  test('an unparseable stamp reads as no clock rather than as NaN minutes', () => {
    expect(elapsedRunMinutes(run({ startedAt: 'whenever' }), at(90))).toBeNull()
  })
})

describe('epicRunCaps', () => {
  test('reports all three ceilings, money first', () => {
    expect(epicRunCaps(run(), T0).map(c => c.label)).toEqual(['spend', 'wall clock', 'generations'])
  })

  test('spend shows what is left, to the cent', () => {
    expect(byLabel(run({ spentUsd: 12.5 }), T0, 'spend')).toMatchObject({
      used: '$12.50',
      limit: '$100.00',
      remaining: '$87.50',
      over: false,
    })
  })

  test('a tripped ceiling says so', () => {
    expect(byLabel(run({ spentUsd: 100 }), T0, 'spend')?.over).toBe(true)
  })

  test('remaining never goes negative -- an overspent run is at 0 left, not at minus', () => {
    expect(byLabel(run({ spentUsd: 140 }), T0, 'spend')?.remaining).toBe('$0.00')
  })

  test('a disarmed cap has no limit and no remaining, rather than a limit of zero', () => {
    expect(byLabel(run({ maxUsd: 0, spentUsd: 9 }), T0, 'spend')).toMatchObject({
      limit: 'no cap',
      remaining: null,
      over: false,
    })
  })

  test('a wall clock that has not started reports no elapsed and no remaining', () => {
    expect(byLabel(run(), T0, 'wall clock')).toMatchObject({ used: 'not started', remaining: null, over: false })
  })

  test('a started wall clock counts up and down', () => {
    expect(byLabel(run({ startedAt: '2026-08-21T00:00:00.000Z' }), at(37), 'wall clock')).toMatchObject({
      used: '37 min',
      limit: '480 min',
      remaining: '443 min',
    })
  })
})

describe('formatEpicRunCaps', () => {
  test('is one line a human and an agent can both read', () => {
    const line = formatEpicRunCaps(run({ spentUsd: 12.5, startedAt: '2026-08-21T00:00:00.000Z' }), at(37))
    expect(line).toBe(
      'spend $12.50/$100.00 ($87.50 left) . wall clock 37 min/480 min (443 min left) . generations 3/40 (37 left)',
    )
  })

  test('marks the ceiling that actually stopped the run', () => {
    expect(formatEpicRunCaps(run({ spentUsd: 250 }), T0)).toContain('spend $250.00/$100.00 ($0.00 left) OVER')
  })
})

test('formatUsd always shows cents', () => {
  expect(formatUsd(12.5)).toBe('$12.50')
  expect(formatUsd(0)).toBe('$0.00')
})
