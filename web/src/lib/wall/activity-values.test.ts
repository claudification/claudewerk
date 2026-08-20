/**
 * THE TWO SILENCES AND THE TWO KINDS OF DOLLAR.
 *
 * Every assertion here is one of the card's honesty rules, checked at the only
 * place a string is built: a silence never prints as a zero, and a dollar never
 * prints without saying whether it was measured or inferred.
 */

import type { ActivityMatrix } from '@shared/activity-matrix'
import { describe, expect, it } from 'vitest'
import {
  activityDayFacts,
  activitySeries,
  formatActivityCount,
  formatActivityDay,
  formatActivityUsd,
  formatHorizon,
  formatUsdProvenance,
} from './activity-values'

const matrix: ActivityMatrix = {
  tz: 'Asia/Bangkok',
  generatedAt: 0,
  defaultMetric: 'commits',
  days: [
    { day: '2026-08-14', dow: 5 },
    { day: '2026-08-15', dow: 6 },
  ],
  metrics: [
    {
      metric: 'commits',
      label: 'Commits',
      unit: 'count',
      horizon: { kind: 'coverage', sinceDay: '2026-08-06', note: 'ledger began at hook install' },
      cells: [{ state: 'active', value: 12 }, { state: 'empty' }],
      max: 12,
      total: 12,
      activeDays: 1,
    },
    {
      metric: 'usd',
      label: 'USD',
      unit: 'usd',
      horizon: { kind: 'retention', retentionDays: 30, note: 'pruned at 30 days' },
      cells: [
        { state: 'active', value: 4.2, usd: { provenance: 'mixed', exactUsd: 3, estimatedUsd: 1.2 } },
        { state: 'unavailable' },
      ],
      max: 4.2,
      total: 4.2,
      activeDays: 1,
    },
  ],
}

describe('a silence never prints as a zero', () => {
  it('says `none` for a day we measured and `no data` for one we did not', () => {
    const second = activityDayFacts(matrix, 1)
    expect(second.map(f => `${f.metric}:${f.text}`)).toEqual(['commits:none', 'usd:no data'])
    // The STATE rides along, so a caller can style them apart without going back
    // to the cell -- which is what stops the two silences merging in the markup.
    expect(second.map(f => f.state)).toEqual(['empty', 'unavailable'])
  })

  it('reports EVERY metric for the hovered day, not just the coloured one', () => {
    // One request, five answers. A grid coloured by commits that could not also
    // say what the day cost lets a loop read as a good week.
    expect(activityDayFacts(matrix, 0).map(f => f.metric)).toEqual(['commits', 'usd'])
  })

  it('treats an index past the axis as unavailable rather than crashing', () => {
    expect(activityDayFacts(matrix, 99).every(f => f.state === 'unavailable')).toBe(true)
  })
})

describe('an estimated dollar is never printed as a measured one', () => {
  it('carries the provenance on every active USD fact', () => {
    const usd = activityDayFacts(matrix, 0).find(f => f.metric === 'usd')
    expect(usd?.text).toBe('$4.20')
    expect(usd?.provenance).toBe('$3.00 measured + $1.20 ESTIMATED')
  })

  it('shouts on a fully inferred day and stays quiet on a measured one', () => {
    expect(formatUsdProvenance({ provenance: 'estimated', exactUsd: 0, estimatedUsd: 9 })).toMatch(/ESTIMATED/)
    expect(formatUsdProvenance({ provenance: 'exact', exactUsd: 9, estimatedUsd: 0 })).toBe('measured')
  })

  it('refuses to round a real spend down to $0.00', () => {
    expect(formatActivityUsd(0.004)).toBe('<$0.01')
    expect(formatActivityUsd(0)).toBe('$0.00')
  })
})

describe('numbers are shortened, never rounded into a different claim', () => {
  it('keeps a count exact until it stops fitting', () => {
    expect(formatActivityCount(9_999, 'count')).toBe('9,999')
    expect(formatActivityCount(45_300, 'tokens')).toBe('45.3k')
    expect(formatActivityCount(1_240_000, 'tokens')).toBe('1.2M')
  })

  it('routes a usd unit to the money format however it is reached', () => {
    expect(formatActivityCount(4.2, 'usd')).toBe('$4.20')
  })
})

describe('a metric says how far back it can see', () => {
  it('spells out that a retention floor is not a row of zeroes', () => {
    expect(formatHorizon({ kind: 'retention', retentionDays: 30, note: '' })).toMatch(/NOT ZERO/)
  })

  it('names the day coverage began, and says so when there is none', () => {
    expect(formatHorizon({ kind: 'coverage', sinceDay: '2026-08-06', note: '' })).toBe('recorded since 2026-08-06')
    expect(formatHorizon({ kind: 'coverage', note: '' })).toBe('nothing recorded yet')
  })

  it('has nothing to warn about when the metric reaches the whole range', () => {
    expect(formatHorizon({ kind: 'unbounded', note: '' })).toBe('every day in range')
  })
})

describe('lookups and labels', () => {
  it('finds a series by id and answers null for one the server did not send', () => {
    expect(activitySeries(matrix, 'commits')?.label).toBe('Commits')
    expect(activitySeries(matrix, 'turns')).toBeNull()
    expect(activitySeries(null, 'commits')).toBeNull()
  })

  it('names a day from the STRING, so no zone can shift it by one', () => {
    // `new Date('2026-08-14')` is UTC midnight, which is the 13th for anyone
    // west of Greenwich -- a label that disagrees with the square it is on.
    expect(formatActivityDay('2026-08-14', 5)).toBe('Fri 14 Aug 2026')
  })
})
