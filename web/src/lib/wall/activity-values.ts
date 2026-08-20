/**
 * WHAT A SQUARE IS WORTH, IN WORDS -- the value half of the activity matrix.
 *
 * Three separate refusals live in here, and every one of them is the card's
 * honesty rule in a different costume:
 *
 *  1. `empty` reads "none" and `unavailable` reads "no data". Two facts, two
 *     sentences. Collapsing them is how a grid tells you eleven months of
 *     missing history were eleven months of idleness.
 *  2. AN ESTIMATED DOLLAR IS NEVER PRINTED AS A MEASURED ONE. Headless turns
 *     file an exact per-turn cost; PTY ones are priced from tokens. The server
 *     carries the split per day, and every USD string built here carries it
 *     onward -- there is no code path that formats a USD cell without saying
 *     which kind it was.
 *  3. A NUMBER IS ONLY EVER SHORTENED, NEVER ROUNDED INTO A CLAIM. `1.2M`
 *     tokens is the same fact as 1,234,567 read from three metres away; `$0.00`
 *     for four-tenths of a cent is not, so that one prints `<$0.01`.
 */

import type { ActivityHorizon, ActivityMatrix, ActivityMetricId, ActivityMetricSeries } from '@shared/activity-matrix'

/** The metric the grid is colouring by, or null when the feed has never landed
 *  or the server stopped sending that one. */
export function activitySeries(matrix: ActivityMatrix | null, metric: ActivityMetricId): ActivityMetricSeries | null {
  return matrix?.metrics.find(m => m.metric === metric) ?? null
}

/** `1,204` / `45.3k` / `1.2M`. Counts stay exact until they stop fitting. */
export function formatActivityCount(value: number, unit: ActivityMetricSeries['unit']): string {
  if (unit === 'usd') return formatActivityUsd(value)
  if (value < 10_000) return value.toLocaleString('en-US')
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** `$4.20`, and `<$0.01` for anything that would round to nothing. A `$0.00`
 *  under a coloured square says "we spent nothing" about a day we spent on. */
export function formatActivityUsd(value: number): string {
  if (value > 0 && value < 0.005) return '<$0.01'
  return `$${value.toFixed(2)}`
}

/**
 * How a day's dollars were arrived at, in the fewest words that stay true.
 *
 * `mixed` spells out BOTH halves rather than picking the bigger one: a day that
 * was 90% measured and 10% inferred is still a day whose total is inferred, and
 * a reader deciding whether to quote the number needs the split, not a verdict.
 */
export function formatUsdProvenance(usd: { provenance: string; exactUsd: number; estimatedUsd: number }): string {
  if (usd.provenance === 'exact') return 'measured'
  if (usd.provenance === 'estimated') return 'ESTIMATED from tokens'
  return `${formatActivityUsd(usd.exactUsd)} measured + ${formatActivityUsd(usd.estimatedUsd)} ESTIMATED`
}

/** One line under the grid saying how far back this metric can see. */
export function formatHorizon(horizon: ActivityHorizon): string {
  if (horizon.kind === 'unbounded') return 'every day in range'
  if (horizon.kind === 'retention') {
    const days = horizon.retentionDays
    return days ? `${days}d retention -- older days are NOT ZERO, they are gone` : horizon.note
  }
  return horizon.sinceDay ? `recorded since ${horizon.sinceDay}` : 'nothing recorded yet'
}

/** One metric's answer for one day. `state` is carried so the caller can style
 *  the two silences differently without re-reading the cell. */
export interface ActivityDayFact {
  metric: ActivityMetricId
  label: string
  /** The number, `none`, or `no data`. Never a bare `0` for a silence. */
  text: string
  state: 'active' | 'empty' | 'unavailable'
  /** USD only: how that number was arrived at. */
  provenance?: string
}

/**
 * EVERY metric's number for one day -- what the hover shows.
 *
 * All five at once is the point of the pane. A grid coloured by commits that
 * cannot also tell you the day cost $180 lets you call a week productive without
 * ever seeing what it took; the contrast between the axes IS the feature, and it
 * costs no extra request because the axis is shared.
 */
export function activityDayFacts(matrix: ActivityMatrix, index: number): ActivityDayFact[] {
  return matrix.metrics.map(series => {
    const cell = series.cells[index] ?? { state: 'unavailable' as const }
    if (cell.state !== 'active') {
      return {
        metric: series.metric,
        label: series.label,
        state: cell.state,
        text: cell.state === 'empty' ? 'none' : 'no data',
      }
    }
    return {
      metric: series.metric,
      label: series.label,
      state: 'active' as const,
      text: formatActivityCount(cell.value ?? 0, series.unit),
      provenance: cell.usd ? formatUsdProvenance(cell.usd) : undefined,
    }
  })
}

/** `Thu 14 Aug 2026` from a `YYYY-MM-DD` the server already bucketed. Built from
 *  the STRING, never from `new Date(day)` -- that parses as UTC midnight and
 *  would name the previous day for any reader west of Greenwich. */
export function formatActivityDay(day: string, dow: number): string {
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [y, m, d] = day.split('-')
  return `${DOW[dow] ?? '??'} ${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`
}
