/**
 * The two splits and the cap state.
 *
 * The claim under test that matters most is a NEGATIVE one: a project's dollars
 * and a feature's dollars never meet. Each split carries its own total and its
 * own shares, so "share" means the same thing inside a split and nothing at all
 * across them.
 */

import { describe, expect, it } from 'vitest'
import {
  type BurnHourlyRow,
  capState,
  costSince,
  featureSplit,
  formatRate,
  formatUsd,
  projectSplit,
  startOfLocalDay,
} from './burn-splits'

const label = (uri: string) => uri.split('/').pop() ?? uri

function row(hour: string, projectUri: string, costUsd: number): BurnHourlyRow {
  return { hour, projectUri, costUsd }
}

const ROWS: BurnHourlyRow[] = [
  row('2026-08-20T09:00:00Z', 'claude://x/projects/anvil', 3),
  row('2026-08-20T09:00:00Z', 'claude://x/projects/remote-claude', 10),
  row('2026-08-20T10:00:00Z', 'claude://x/projects/remote-claude', 5),
  row('2026-08-20T10:00:00Z', '', 1),
]

const AT_11 = Date.parse('2026-08-20T11:00:00Z')

describe('costSince', () => {
  it('sums the buckets at or after the boundary', () => {
    expect(costSince(ROWS, Date.parse('2026-08-20T10:00:00Z'))).toBe(6)
    expect(costSince(ROWS, Date.parse('2026-08-20T09:00:00Z'))).toBe(19)
  })

  it('is zero, not NaN, when every bucket is older', () => {
    expect(costSince(ROWS, AT_11)).toBe(0)
  })

  it('skips a bucket key it cannot parse instead of poisoning the total', () => {
    expect(costSince([...ROWS, row('not-a-date', 'x', 99)], Date.parse('2026-08-20T09:00:00Z'))).toBe(19)
  })
})

describe('startOfLocalDay', () => {
  it('lands on local midnight', () => {
    const midnight = startOfLocalDay(Date.parse('2026-08-20T11:00:00Z'))
    const d = new Date(midnight)
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0])
  })
})

describe('projectSplit', () => {
  it('merges a project across buckets and sorts by spend', () => {
    const split = projectSplit(ROWS, 0, label)
    expect(split.bars.map(b => [b.label, b.costUsd])).toEqual([
      ['remote-claude', 15],
      ['anvil', 3],
      ['unattributed', 1],
    ])
    expect(split.total).toBe(19)
  })

  it('shares sum to 1 within the split', () => {
    const split = projectSplit(ROWS, 0, label)
    expect(split.bars.reduce((s, b) => s + b.share, 0)).toBeCloseTo(1, 9)
    expect(split.bars[0]?.share).toBeCloseTo(15 / 19, 9)
  })

  it('names unattributed turns rather than folding them into a real project', () => {
    const split = projectSplit(ROWS, 0, label)
    expect(split.bars.find(b => b.label === 'unattributed')?.costUsd).toBe(1)
  })

  it('is empty -- not zero-barred -- when the window holds nothing', () => {
    expect(projectSplit(ROWS, AT_11, label)).toEqual({ bars: [], total: 0 })
  })
})

describe('featureSplit', () => {
  it('keeps its own total, independent of any project split', () => {
    const feature = featureSplit([
      { key: 'recap', costUsd: 4 },
      { key: 'voice', costUsd: 1 },
      { key: 'desk', costUsd: 0 },
    ])
    expect(feature.total).toBe(5)
    expect(feature.bars.map(b => b.key)).toEqual(['recap', 'voice'])
    expect(feature.bars[0]?.share).toBeCloseTo(0.8, 9)
  })

  it('NEVER shares a denominator with the project split', () => {
    const projects = projectSplit(ROWS, 0, label)
    const features = featureSplit([{ key: 'recap', costUsd: 4 }])
    // The one bar in the feature split is 100% of ITS split, even though it is
    // a rounding error next to the $19 of project spend beside it.
    expect(features.bars[0]?.share).toBe(1)
    expect(features.total).toBe(4)
    expect(projects.total).toBe(19)
    // The pane has no expression that adds these; the shapes stay separate.
    expect(projects.bars.some(b => b.key === 'recap')).toBe(false)
  })
})

describe('capState', () => {
  it('says NO CAP when none is configured', () => {
    expect(capState(undefined, 15_500)).toEqual({ kind: 'none' })
    expect(capState(0, 15_500)).toEqual({ kind: 'none' })
    expect(capState(Number.NaN, 15_500)).toEqual({ kind: 'none' })
    expect(capState(-5, 15_500)).toEqual({ kind: 'none' })
  })

  it('reports the share against a cap that IS set', () => {
    expect(capState(1000, 250)).toEqual({ kind: 'set', capUsd: 1000, share: 0.25, over: false })
  })

  it('flags a breach', () => {
    const state = capState(1000, 1500)
    expect(state.kind === 'set' && state.over).toBe(true)
  })
})

describe('formatting', () => {
  it('scales to the magnitude', () => {
    expect(formatUsd(0.034)).toBe('$0.03')
    expect(formatUsd(45.6)).toBe('$45.60')
    expect(formatUsd(432.1)).toBe('$432')
    expect(formatUsd(15_500)).toBe('$15.5k')
  })

  it('dashes anything it was never given', () => {
    expect(formatUsd(null)).toBe('--')
    expect(formatUsd(undefined)).toBe('--')
    expect(formatUsd(Number.NaN)).toBe('--')
    expect(formatRate(null)).toBe('--/h')
  })

  it('renders a real rate with its unit', () => {
    expect(formatRate(12.5)).toBe('$12.50/h')
  })
})
