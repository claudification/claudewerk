/**
 * The assembler's two jobs, both of which are honesty rules:
 *
 *   1. a day outside a metric's horizon is `unavailable`, and `unavailable` is
 *      NOT `empty` -- switching the grid to a 30-day metric must make eleven
 *      months read "no data", never "idle";
 *   2. a USD day says whether its number was measured or inferred.
 */

import { describe, expect, it } from 'bun:test'
import type { ActivityCell, ActivityMetricId } from '../../shared/activity-matrix'
import type { TurnActivityRow } from '../store/types'
import { buildDayAxis } from './days'
import { type ActivitySources, buildActivityMatrix } from './matrix'

const BANGKOK = 'Asia/Bangkok'
/** 2026-08-20 21:30 Bangkok. Mid-evening, so "today" is unambiguous locally. */
const NOW = Date.parse('2026-08-20T14:30:00Z')
const DAY = 86_400_000

function emptySources(over: Partial<ActivitySources> = {}): ActivitySources {
  return { turns: () => [], commits: () => [], earliestCommitAt: () => null, cardCloses: () => [], ...over }
}

function turn(timestamp: number, over: Partial<TurnActivityRow> = {}): TurnActivityRow {
  return { timestamp, tokens: 100, costUsd: 1, exactCost: true, ...over }
}

/** Local noon on the day `back` days before today, in Bangkok. */
function noonDaysAgo(back: number): number {
  const axis = buildDayAxis(NOW, back + 1, BANGKOK)
  return axis[0].startMs + 12 * 3_600_000
}

function seriesOf(matrix: ReturnType<typeof buildActivityMatrix>, id: ActivityMetricId) {
  const s = matrix.metrics.find(m => m.metric === id)
  if (!s) throw new Error(`no series for ${id}`)
  return s
}

function cellOn(matrix: ReturnType<typeof buildActivityMatrix>, id: ActivityMetricId, day: string): ActivityCell {
  const i = matrix.days.findIndex(d => d.day === day)
  expect(i).toBeGreaterThanOrEqual(0)
  return seriesOf(matrix, id).cells[i]
}

describe('buildActivityMatrix -- shape', () => {
  const matrix = buildActivityMatrix(emptySources(), { tz: BANGKOK, days: 366, now: NOW })

  it('echoes the requested zone and defaults to the one OUTPUT metric that can fill the grid', () => {
    expect(matrix.tz).toBe(BANGKOK)
    expect(matrix.defaultMetric).toBe('commits')
  })

  it('aligns every metric to the shared day axis, so a hover is an index lookup', () => {
    expect(matrix.days).toHaveLength(366)
    expect(matrix.metrics).toHaveLength(5)
    for (const s of matrix.metrics) expect(s.cells).toHaveLength(matrix.days.length)
  })

  it('orders the switch output-first, volume alongside', () => {
    expect(matrix.metrics.map(m => m.metric)).toEqual(['commits', 'cardsClosed', 'turns', 'tokens', 'usd'])
  })

  it('ends on today in the requested zone', () => {
    expect(matrix.days[matrix.days.length - 1].day).toBe('2026-08-20')
  })
})

describe('horizons -- `unavailable` is not `empty`', () => {
  it('marks turns/tokens/USD unavailable past the 30-day sweep', () => {
    const matrix = buildActivityMatrix(emptySources(), { tz: BANGKOK, days: 366, now: NOW })
    for (const id of ['turns', 'tokens', 'usd'] as const) {
      const series = seriesOf(matrix, id)
      expect(series.horizon).toMatchObject({ kind: 'retention', retentionDays: 30 })
      // The oldest square is a year back: outside the window, so NOT empty.
      expect(series.cells[0].state).toBe('unavailable')
      // A day inside the window with nothing in it IS empty.
      expect(cellOn(matrix, id, '2026-08-19').state).toBe('empty')
    }
  })

  it('marks card closes unavailable past the 90-day sweep but available at 60', () => {
    const matrix = buildActivityMatrix(emptySources(), { tz: BANGKOK, days: 366, now: NOW })
    const series = seriesOf(matrix, 'cardsClosed')
    expect(series.horizon).toMatchObject({ kind: 'retention', retentionDays: 90 })
    expect(series.cells[0].state).toBe('unavailable')
    const sixtyDaysAgo = buildDayAxis(NOW - 60 * DAY, 1, BANGKOK)[0].day
    expect(cellOn(matrix, 'cardsClosed', sixtyDaysAgo).state).toBe('empty')
    // And a 30-day metric is grey on that same square, which is the whole point
    // of per-metric horizons: same day, different amount of knowledge.
    expect(cellOn(matrix, 'turns', sixtyDaysAgo).state).toBe('unavailable')
  })

  it('floors commits at the ledger install, not at a retention window', () => {
    const earliest = NOW - 40 * DAY
    const matrix = buildActivityMatrix(emptySources({ earliestCommitAt: () => earliest }), {
      tz: BANGKOK,
      days: 366,
      now: NOW,
    })
    const series = seriesOf(matrix, 'commits')
    expect(series.horizon.kind).toBe('coverage')
    expect(series.horizon.retentionDays).toBeUndefined()
    // 39 days back is inside coverage; 41 is before the ledger existed.
    expect(cellOn(matrix, 'commits', buildDayAxis(NOW - 39 * DAY, 1, BANGKOK)[0].day).state).toBe('empty')
    expect(cellOn(matrix, 'commits', buildDayAxis(NOW - 41 * DAY, 1, BANGKOK)[0].day).state).toBe('unavailable')
    // ...and commits reach FURTHER back than the 30-day metrics, which is why
    // it is the default.
    expect(cellOn(matrix, 'turns', buildDayAxis(NOW - 39 * DAY, 1, BANGKOK)[0].day).state).toBe('unavailable')
  })

  it('calls an empty commit ledger unavailable everywhere rather than idle everywhere', () => {
    const matrix = buildActivityMatrix(emptySources(), { tz: BANGKOK, days: 30, now: NOW })
    const series = seriesOf(matrix, 'commits')
    expect(series.horizon.sinceDay).toBeUndefined()
    expect(series.cells.every(cell => cell.state === 'unavailable')).toBe(true)
  })
})

describe('values', () => {
  it('counts commits and card closes on the local day they happened', () => {
    const today = noonDaysAgo(0)
    const matrix = buildActivityMatrix(
      emptySources({
        commits: () => [today, today, today - DAY],
        earliestCommitAt: () => today - 10 * DAY,
        cardCloses: () => [today - DAY],
      }),
      { tz: BANGKOK, days: 366, now: NOW },
    )
    expect(cellOn(matrix, 'commits', '2026-08-20')).toEqual({ state: 'active', value: 2 })
    expect(cellOn(matrix, 'commits', '2026-08-19')).toEqual({ state: 'active', value: 1 })
    expect(cellOn(matrix, 'cardsClosed', '2026-08-19')).toEqual({ state: 'active', value: 1 })
    expect(seriesOf(matrix, 'commits')).toMatchObject({ max: 2, total: 3, activeDays: 2 })
  })

  it('never carries a value on a non-active cell -- there is no zero to colour', () => {
    const matrix = buildActivityMatrix(emptySources(), { tz: BANGKOK, days: 366, now: NOW })
    for (const series of matrix.metrics) {
      for (const cell of series.cells) {
        if (cell.state !== 'active') expect(cell.value).toBeUndefined()
      }
    }
  })

  it('puts a 01:30 Bangkok turn on the 21st, where a UTC grid would say the 20th', () => {
    // 2026-08-20T18:30Z is 01:30 on the 21st in Bangkok but still the 20th in
    // UTC. Bucketed correctly it lands on the 21st.
    const crossover = Date.parse('2026-08-20T18:30:00Z')
    const matrix = buildActivityMatrix(emptySources({ turns: () => [turn(crossover)] }), {
      tz: BANGKOK,
      days: 366,
      now: NOW + 12 * 3_600_000,
    })
    expect(cellOn(matrix, 'turns', '2026-08-21')).toMatchObject({ state: 'active', value: 1 })
    expect(cellOn(matrix, 'turns', '2026-08-20').state).toBe('empty')
  })

  it('folds one pass over turns into all three of its metrics', () => {
    const t = noonDaysAgo(0)
    const matrix = buildActivityMatrix(
      emptySources({ turns: () => [turn(t, { tokens: 10, costUsd: 2 }), turn(t, { tokens: 5, costUsd: 3 })] }),
      { tz: BANGKOK, days: 366, now: NOW },
    )
    expect(cellOn(matrix, 'turns', '2026-08-20').value).toBe(2)
    expect(cellOn(matrix, 'tokens', '2026-08-20').value).toBe(15)
    expect(cellOn(matrix, 'usd', '2026-08-20').value).toBe(5)
  })
})

describe('USD provenance -- an estimate is never served as a measurement', () => {
  const t = noonDaysAgo(0)

  it('says `exact` when every turn that day filed a real cost', () => {
    const matrix = buildActivityMatrix(emptySources({ turns: () => [turn(t, { costUsd: 2, exactCost: true })] }), {
      tz: BANGKOK,
      days: 30,
      now: NOW,
    })
    expect(cellOn(matrix, 'usd', '2026-08-20').usd).toEqual({ provenance: 'exact', exactUsd: 2, estimatedUsd: 0 })
  })

  it('says `estimated` when the day was priced from tokens', () => {
    const matrix = buildActivityMatrix(emptySources({ turns: () => [turn(t, { costUsd: 2, exactCost: false })] }), {
      tz: BANGKOK,
      days: 30,
      now: NOW,
    })
    expect(cellOn(matrix, 'usd', '2026-08-20').usd).toEqual({ provenance: 'estimated', exactUsd: 0, estimatedUsd: 2 })
  })

  it('says `mixed` and keeps both halves separate', () => {
    const matrix = buildActivityMatrix(
      emptySources({
        turns: () => [turn(t, { costUsd: 2, exactCost: true }), turn(t, { costUsd: 3, exactCost: false })],
      }),
      { tz: BANGKOK, days: 30, now: NOW },
    )
    const cell = cellOn(matrix, 'usd', '2026-08-20')
    expect(cell.value).toBe(5)
    expect(cell.usd).toEqual({ provenance: 'mixed', exactUsd: 2, estimatedUsd: 3 })
  })

  it('attaches provenance to the USD metric only', () => {
    const matrix = buildActivityMatrix(emptySources({ turns: () => [turn(t)] }), { tz: BANGKOK, days: 30, now: NOW })
    expect(cellOn(matrix, 'turns', '2026-08-20').usd).toBeUndefined()
    expect(cellOn(matrix, 'tokens', '2026-08-20').usd).toBeUndefined()
  })
})
