/**
 * THE GRID's GEOMETRY -- days in, columns of seven out. No React, no DOM.
 *
 * GitHub's shape: one COLUMN per week, seven rows, weekday 0 (Sunday) at the
 * top. The axis almost never starts on a Sunday, so the first column is padded
 * at the top and the last at the bottom; a pad is `null` and renders as nothing
 * at all, which is a fourth thing on screen and must not be confused with the
 * three CELL STATES it sits beside.
 *
 * THE LEVEL IS COMPUTED FOR `active` CELLS AND FOR NOTHING ELSE, and that is the
 * whole honesty rule expressed as a type: `empty` and `unavailable` carry no
 * level, so there is no number for a colour scale to reach for. A fold that gave
 * every cell a level would put `unavailable` at the bottom of the same ramp as a
 * quiet day, and eleven months of missing history would read as eleven months of
 * idleness -- the failure the three states exist to prevent, arriving through
 * the renderer instead of through the payload.
 *
 * `dow` COMES FROM THE SERVER. The axis was bucketed in the zone the pane asked
 * for, and the browser's zone is not necessarily that zone -- re-deriving the
 * weekday here would slide the whole grid by a row for anyone reading it from
 * somewhere else.
 */

import type { ActivityAxisDay, ActivityCell, ActivityMetricSeries } from '@shared/activity-matrix'

/** How many shades the ramp has. Four, like GitHub -- enough to read a trend
 *  across a year, few enough to tell two adjacent squares apart at a glance. */
export const ACTIVITY_LEVELS = 4

/**
 * A day, carrying WHERE IT SITS on the server's axis.
 *
 * The position is threaded through rather than re-derived from the loop, because
 * the pane filters days (free text over the date narrows the grid to a month)
 * and every metric's `cells` array is still indexed against the FULL axis. A
 * fold that used its own loop counter would, the moment anything was filtered,
 * colour each remaining square with some other day's number.
 */
export type ActivityAxisEntry = ActivityAxisDay & { index: number }

/** One square. `level` is present exactly when the cell is `active`. */
export interface ActivitySquare {
  /** Index into the SHARED axis, which is how the hover reaches every metric's
   *  number for this day without a second lookup key. */
  index: number
  day: ActivityAxisDay
  cell: ActivityCell
  /** 1..`ACTIVITY_LEVELS`, or 0 when this square has no value to colour. */
  level: number
}

/** A column. `null` is a pad -- a square outside the axis, not a quiet day. */
export interface ActivityWeek {
  /** Stable across re-renders: the first real day in the column. */
  key: string
  squares: (ActivitySquare | null)[]
}

/**
 * Which shade an active value gets, 1..4.
 *
 * A LINEAR ramp against the metric's own max, and never a shared one: the five
 * metrics are counts, tokens and dollars, three quantities with no common scale.
 * The floor is 1 rather than 0 -- a day with the least work of the year still
 * had work, and painting it as the empty shade would delete it.
 */
export function activityLevel(value: number, max: number): number {
  if (max <= 0) return 1
  const level = Math.ceil((value / max) * ACTIVITY_LEVELS)
  return Math.min(ACTIVITY_LEVELS, Math.max(1, level))
}

/**
 * Fold the axis and ONE metric's cells into columns of seven.
 *
 * A DAY IS PLACED ON ITS OWN WEEKDAY ROW, never appended in order. The two are
 * the same thing on a contiguous axis and come apart the moment one is filtered:
 * typing `2026-08` narrows the grid to August, and a fold that just appended
 * would slide every remaining square onto the wrong row. Placing by `dow` and
 * starting a fresh column whenever the weekday goes backwards keeps a Tuesday on
 * the Tuesday row through any gap.
 */
export function activityWeeks(
  entries: readonly ActivityAxisEntry[],
  series: ActivityMetricSeries | null,
): ActivityWeek[] {
  const weeks: ActivityWeek[] = []
  let column: (ActivitySquare | null)[] = Array.from({ length: 7 }, () => null)
  let lastDow = -1

  const push = () => {
    const first = column.find((s): s is ActivitySquare => s !== null)
    if (first) weeks.push({ key: first.day.day, squares: column })
  }

  for (const entry of entries) {
    if (lastDow >= 0 && entry.dow <= lastDow) {
      push()
      column = Array.from({ length: 7 }, () => null)
    }
    const cell = series?.cells[entry.index] ?? { state: 'unavailable' as const }
    column[entry.dow] = {
      index: entry.index,
      day: entry,
      cell,
      level: cell.state === 'active' ? activityLevel(cell.value ?? 0, series?.max ?? 0) : 0,
    }
    lastDow = entry.dow
  }
  push()
  return weeks
}

/** A month name over the column where that month first appears. */
export interface ActivityMonthLabel {
  /** Column index the label sits above. */
  week: number
  label: string
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/**
 * Month labels, one per month that OWNS a column.
 *
 * Read off the `YYYY-MM` prefix of the server's day strings rather than by
 * parsing them into `Date`s -- the strings are already in the requested zone and
 * a `new Date('2026-08-14')` would re-read them as UTC midnight, which is the
 * previous month's last day for anyone west of Greenwich.
 *
 * A month whose first column would collide with the previous label is skipped:
 * a five-week gap is the ordinary case and a one-week one is a month that began
 * mid-column, where two labels a few pixels apart read as noise.
 */
export function activityMonthLabels(weeks: readonly ActivityWeek[]): ActivityMonthLabel[] {
  const labels: ActivityMonthLabel[] = []
  let previous = ''
  for (const [week, column] of weeks.entries()) {
    const first = column.squares.find((s): s is ActivitySquare => s !== null)
    if (!first) continue
    const month = first.day.day.slice(0, 7)
    if (month === previous) continue
    previous = month
    const last = labels[labels.length - 1]
    if (last && week - last.week < 3) continue
    labels.push({ week, label: MONTHS[Number(month.slice(5, 7)) - 1] ?? month })
  }
  return labels
}
