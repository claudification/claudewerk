/**
 * THE THREE-STATE CELL, proved where it is decided.
 *
 * The pane's suite proves the three states are drawn differently. This one
 * proves the FOLD never lets them become two: an `unavailable` day must not
 * acquire a level on its way to the renderer, because a level is a colour and a
 * colour on a day nobody has data for is the lie the whole card is about.
 */

import type { ActivityCell, ActivityMetricSeries } from '@shared/activity-matrix'
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_LEVELS,
  type ActivityAxisEntry,
  activityLevel,
  activityMonthLabels,
  activityWeeks,
} from './activity-grid'

/** `n` consecutive days starting on the weekday asked for. 2026-08-02 is a
 *  Sunday, so `startDow` is simply an offset from it. */
function axis(n: number, startDow = 0): ActivityAxisEntry[] {
  const start = new Date(2026, 7, 2 + startDow)
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const pad = (v: number) => String(v).padStart(2, '0')
    return { day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, dow: d.getDay(), index: i }
  })
}

function series(cells: ActivityCell[], over: Partial<ActivityMetricSeries> = {}): ActivityMetricSeries {
  const values = cells.filter(c => c.state === 'active').map(c => c.value ?? 0)
  return {
    metric: 'commits',
    label: 'Commits',
    unit: 'count',
    horizon: { kind: 'unbounded', note: '' },
    cells,
    max: values.length ? Math.max(...values) : 0,
    total: values.reduce((a, b) => a + b, 0),
    activeDays: values.length,
    ...over,
  }
}

const ACTIVE = (value: number): ActivityCell => ({ state: 'active', value })
const EMPTY: ActivityCell = { state: 'empty' }
const GONE: ActivityCell = { state: 'unavailable' }

describe('a level is a colour, so only an ACTIVE cell gets one', () => {
  it('gives `empty` and `unavailable` no level at all', () => {
    const days = axis(3)
    const weeks = activityWeeks(days, series([ACTIVE(4), EMPTY, GONE]))
    const [a, b, c] = weeks[0].squares.slice(0, 3)

    expect(a?.level).toBeGreaterThan(0)
    expect(b?.level).toBe(0)
    expect(c?.level).toBe(0)
    // ...and the two silences stay TOLD APART, which is the whole point: they
    // share a level and differ only in `state`, so a renderer that keyed on the
    // level alone would paint them identically and nothing here would notice.
    expect([b?.cell.state, c?.cell.state]).toEqual(['empty', 'unavailable'])
  })

  it('never lets the quietest active day fall to the empty shade', () => {
    // 1 commit against a year that peaked at 400 is still a day work happened
    // on. Rounded to 0 it would be indistinguishable from a day off.
    expect(activityLevel(1, 400)).toBe(1)
    expect(activityLevel(400, 400)).toBe(ACTIVITY_LEVELS)
    expect(activityLevel(200, 400)).toBe(ACTIVITY_LEVELS / 2)
  })

  it('does not divide by a max of zero when a metric has no active day', () => {
    expect(activityLevel(0, 0)).toBe(1)
    const weeks = activityWeeks(axis(2), series([EMPTY, GONE]))
    expect(weeks[0].squares.slice(0, 2).map(s => s?.level)).toEqual([0, 0])
  })

  it('treats a metric the server did not send as UNAVAILABLE, never as empty', () => {
    // A missing series is "we were not told", which is exactly `unavailable`.
    // Defaulting it to `empty` would report silence we never measured.
    const weeks = activityWeeks(axis(1), null)
    expect(weeks[0].squares[0]?.cell.state).toBe('unavailable')
  })

  it('colours a FILTERED day with its OWN number, not the one at its new position', () => {
    // The failure this pins: narrow the grid to a month and every square takes
    // the value of whatever now sits at that loop index. `index` on the entry is
    // what stops it -- the cells stay indexed against the full axis.
    const full = axis(9)
    const cells = Array.from({ length: 9 }, (_, i) => ACTIVE(i + 1))
    const weeks = activityWeeks([full[7], full[8]], series(cells))
    expect(weeks[0].squares.filter(Boolean).map(s => s?.cell.value)).toEqual([8, 9])
  })
})

describe("the geometry is GitHub's: a column per week, weekday down the side", () => {
  it('pads the first column at the TOP so every square sits on its weekday row', () => {
    // An axis starting on a Wednesday (dow 3) owes three pads above it.
    const days = axis(4, 3)
    expect(days[0].dow).toBe(3)
    const weeks = activityWeeks(days, series([ACTIVE(1), ACTIVE(1), ACTIVE(1), ACTIVE(1)]))
    expect(weeks[0].squares.slice(0, 3)).toEqual([null, null, null])
    expect(weeks[0].squares[3]?.day.dow).toBe(3)
  })

  it('pads the last column at the BOTTOM, and every column is seven tall', () => {
    const weeks = activityWeeks(axis(10), series(Array.from({ length: 10 }, () => ACTIVE(1))))
    expect(weeks).toHaveLength(2)
    for (const week of weeks) expect(week.squares).toHaveLength(7)
    expect(weeks[1].squares.slice(3)).toEqual([null, null, null, null])
  })

  it('carries the axis INDEX on every square, so a hover reaches all five metrics', () => {
    const weeks = activityWeeks(axis(9), series(Array.from({ length: 9 }, (_, i) => ACTIVE(i + 1))))
    expect(weeks[0].squares[0]?.index).toBe(0)
    expect(weeks[1].squares[1]?.index).toBe(8)
  })

  it('keeps the DOW the SERVER sent rather than re-deriving it here', () => {
    // The axis was bucketed in the zone the pane asked for; the browser's zone
    // is not necessarily that zone, and re-parsing would slide the whole grid.
    const weeks = activityWeeks([{ day: '2026-08-14', dow: 2, index: 0 }], series([ACTIVE(3)]))
    expect(weeks[0].squares[2]?.day.day).toBe('2026-08-14')
    expect(weeks[0].squares.slice(0, 2)).toEqual([null, null])
  })

  it('has nothing to draw for an empty axis', () => {
    expect(activityWeeks([], null)).toEqual([])
  })
})

describe('month labels', () => {
  it('names a month once, over the column it starts in', () => {
    const weeks = activityWeeks(axis(70), series(Array.from({ length: 70 }, () => ACTIVE(1))))
    const labels = activityMonthLabels(weeks)
    expect(labels.map(l => l.label)).toEqual(['AUG', 'SEP', 'OCT'])
    expect(labels[0].week).toBe(0)
  })

  it('drops a label that would collide with the one before it', () => {
    // A month that owns fewer than three columns gets no label rather than one
    // printed on top of its neighbour.
    const weeks = activityWeeks(axis(40), series(Array.from({ length: 40 }, () => ACTIVE(1))))
    const labels = activityMonthLabels(weeks)
    for (const [i, label] of labels.entries()) {
      if (i > 0) expect(label.week - labels[i - 1].week).toBeGreaterThanOrEqual(3)
    }
  })
})
