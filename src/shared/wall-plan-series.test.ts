import { describe, expect, it } from 'bun:test'
import type { WallPlanSample } from './wall'
import {
  appendPlanSample,
  flattenPlanSeries,
  foldPlanSamples,
  prunePlanSeries,
  WALL_PLAN_WINDOW_MS,
  type WallPlanSeries,
  wallPlanKey,
} from './wall-plan-series'

const T0 = 1_760_000_000_000

function sample(over: Partial<WallPlanSample> = {}): WallPlanSample {
  return { profile: 'default', utilization: 40, at: T0, state: 'ok', ...over }
}

function series(): WallPlanSeries {
  return new Map()
}

describe('wall plan series: keying', () => {
  it('keys by profile PLUS node -- the same name on two sentinels is two accounts', () => {
    expect(wallPlanKey({ profile: 'work' })).toBe('work')
    expect(wallPlanKey({ profile: 'work', node: 'studio' })).toBe('work@studio')
    expect(wallPlanKey({ profile: 'work', node: 'nas' })).not.toBe(wallPlanKey({ profile: 'work', node: 'studio' }))
  })

  it('keeps one series per key rather than one shared line', () => {
    const all = series()
    appendPlanSample(all, sample({ node: 'studio', utilization: 10 }), T0)
    appendPlanSample(all, sample({ node: 'nas', utilization: 90 }), T0)

    expect(all.size).toBe(2)
    expect(all.get('default@studio')?.[0]?.utilization).toBe(10)
    expect(all.get('default@nas')?.[0]?.utilization).toBe(90)
  })

  it('does not let a busy profile evict a quiet one -- a flat FIFO would', () => {
    const all = series()
    appendPlanSample(all, sample({ node: 'nas', at: T0 }), T0)
    // Four hours of once-a-minute samples on the other node: 240 points, more
    // than a single shared ring would have held alongside nas's one.
    for (let i = 1; i <= 240; i++) {
      appendPlanSample(all, sample({ node: 'studio', at: T0 + i * 60_000, utilization: i % 100 }), T0 + i * 60_000)
    }

    expect(all.get('default@studio')?.length).toBeGreaterThan(200)
    expect(all.get('default@nas')).toHaveLength(1)
  })
})

describe('wall plan series: bounding', () => {
  it('drops samples that fall out of the 5h window', () => {
    const all = series()
    appendPlanSample(all, sample({ at: T0 }), T0)
    const later = T0 + WALL_PLAN_WINDOW_MS + 60_000
    appendPlanSample(all, sample({ at: later, utilization: 55 }), later)

    expect(all.get('default')).toHaveLength(1)
    expect(all.get('default')?.[0]?.utilization).toBe(55)
  })

  it('refuses a sample that is already older than the window', () => {
    const all = series()
    const now = T0 + WALL_PLAN_WINDOW_MS * 2
    expect(appendPlanSample(all, sample({ at: T0 }), now)).toBe(false)
    expect(all.size).toBe(0)
  })

  it('honours the per-series cap even when the min gap is off', () => {
    const all = series()
    for (let i = 0; i < 500; i++) {
      appendPlanSample(all, sample({ at: T0 + i, utilization: i % 97 }), T0 + i, { minGapMs: 0, cap: 50 })
    }
    expect(all.get('default')).toHaveLength(50)
  })

  it('evicts the coldest series past the key cap', () => {
    const all = series()
    appendPlanSample(all, sample({ profile: 'cold', at: T0 }), T0)
    appendPlanSample(all, sample({ profile: 'warm', at: T0 + 1000 }), T0 + 1000)
    appendPlanSample(all, sample({ profile: 'new', at: T0 + 2000 }), T0 + 2000, { keyCap: 2 })

    expect([...all.keys()].sort()).toEqual(['new', 'warm'])
  })

  it('prunes on demand and forgets a series that empties out', () => {
    const all = series()
    appendPlanSample(all, sample({ at: T0 }), T0)
    prunePlanSeries(all, T0 + WALL_PLAN_WINDOW_MS + 1)
    expect(all.size).toBe(0)
  })
})

describe('wall plan series: thinning', () => {
  it('thins a repeated identical reading inside the min gap', () => {
    const all = series()
    appendPlanSample(all, sample({ at: T0 }), T0)
    expect(appendPlanSample(all, sample({ at: T0 + 5_000 }), T0 + 5_000)).toBe(false)
    expect(all.get('default')).toHaveLength(1)
  })

  it('never thins away a real move', () => {
    const all = series()
    appendPlanSample(all, sample({ at: T0, utilization: 40 }), T0)
    expect(appendPlanSample(all, sample({ at: T0 + 5_000, utilization: 95 }), T0 + 5_000)).toBe(true)
    expect(all.get('default')).toHaveLength(2)
  })

  it('never thins away a state change -- live 62% and stale 62% are different facts', () => {
    const all = series()
    appendPlanSample(all, sample({ at: T0, utilization: 62 }), T0)
    const kept = appendPlanSample(all, sample({ at: T0 + 1_000, utilization: 62, stale: true }), T0 + 1_000)

    expect(kept).toBe(true)
    expect(all.get('default')?.[1]?.stale).toBe(true)
  })

  it('keeps a quiet reading once the min gap has passed', () => {
    const all = series()
    appendPlanSample(all, sample({ at: T0 }), T0)
    expect(appendPlanSample(all, sample({ at: T0 + 61_000 }), T0 + 61_000)).toBe(true)
  })

  it('drops a reading that arrives out of order rather than redrawing history', () => {
    const all = series()
    appendPlanSample(all, sample({ at: T0 + 120_000, utilization: 70 }), T0 + 120_000)
    expect(appendPlanSample(all, sample({ at: T0, utilization: 10 }), T0 + 120_000)).toBe(false)
    expect(all.get('default')).toHaveLength(1)
  })

  it('keeps everything when the caller turns the min gap off', () => {
    const all = series()
    foldPlanSamples(all, [sample({ at: T0 }), sample({ at: T0 + 1 }), sample({ at: T0 + 2 })], T0 + 2, { minGapMs: 0 })
    expect(all.get('default')).toHaveLength(3)
  })
})

describe('wall plan series: flatten', () => {
  it('returns every sample oldest first across every series', () => {
    const all = series()
    appendPlanSample(all, sample({ node: 'a', at: T0 + 2_000 }), T0 + 2_000)
    appendPlanSample(all, sample({ node: 'b', at: T0 + 1_000 }), T0 + 2_000)
    appendPlanSample(all, sample({ node: 'a', at: T0 + 3_000, utilization: 99 }), T0 + 3_000)

    expect(flattenPlanSeries(all).map(s => s.at)).toEqual([T0 + 1_000, T0 + 2_000, T0 + 3_000])
  })
})
