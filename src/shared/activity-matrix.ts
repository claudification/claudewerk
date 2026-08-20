/**
 * THE ACTIVITY MATRIX -- the wire contract for five day-bucketed metrics.
 *
 * A contribution grid makes any number look authoritative, so this shape is
 * built around the two things a heatmap normally lies about:
 *
 *  1. A DAY CELL HAS THREE STATES, NOT TWO. `empty` means "we have the data and
 *     there was no work". `unavailable` means "this day is outside what this
 *     metric can see -- we do not know". Folding those together paints eleven
 *     months of missing history as eleven months of idleness, which is the exact
 *     failure the grid exists to avoid. They are distinct values here so the pane
 *     is physically able to draw them differently.
 *
 *  2. EVERY METRIC DECLARES ITS OWN HORIZON. The five sources do not share a
 *     retention window -- turns/tokens/USD are pruned at 30 days, card moves at
 *     90, and the commit ledger only knows what it has ingested since the hook
 *     was installed. A single grid-wide "range" would have to pick one of those
 *     and be wrong about four. So the horizon travels WITH the metric.
 *
 * USD CARRIES ITS PROVENANCE. Headless conversations file an exact per-turn cost;
 * PTY ones are priced from tokens. An estimated number is never rendered as a
 * measured one, and the client cannot honour that rule if the server does not
 * tell it which is which -- so the split rides in the cell.
 *
 * ALIGNMENT IS THE CONTRACT. `days` is the shared axis and every metric's
 * `cells` array has exactly that length, in that order. The pane's hover
 * ("the day's numbers on EVERY metric at once") is then an index lookup rather
 * than five more requests.
 */

/** Which truth the grid is currently colouring by. */
export type ActivityMetricId = 'commits' | 'cardsClosed' | 'turns' | 'tokens' | 'usd'

/**
 * The three states a day cell can be in.
 *
 * `unavailable` is the one that matters: it is NOT zero, it is "out of this
 * metric's horizon". Switching the grid from `commits` to `turns` should make
 * eleven months visibly go *no data*, not visibly go *idle*.
 */
export type ActivityCellState = 'active' | 'empty' | 'unavailable'

/** How a USD day's number was arrived at. `mixed` = both kinds of turn that day. */
export type ActivityUsdProvenance = 'exact' | 'estimated' | 'mixed'

/** One day on the shared axis. `dow` is 0-6 (0 = Sunday) so the pane can lay out
 *  GitHub's column-per-week grid without re-parsing the date in the browser's
 *  own timezone -- which is not necessarily the one that was requested. */
export interface ActivityAxisDay {
  /** `YYYY-MM-DD` as the calendar reads in the REQUESTED timezone. */
  day: string
  dow: number
}

/** The USD split for one day. Present only on `active` USD cells. */
export interface ActivityUsdDetail {
  provenance: ActivityUsdProvenance
  /** Portion of the day's total that came from turns carrying a real cost. */
  exactUsd: number
  /** Portion priced from tokens. Never render this as a measurement. */
  estimatedUsd: number
}

export interface ActivityCell {
  state: ActivityCellState
  /** ABSENT unless `state === 'active'`. A zero here would be the very
   *  "zero-with-a-colour" the three states exist to prevent. */
  value?: number
  /** USD metric only, and only on `active` cells. */
  usd?: ActivityUsdDetail
}

/**
 * Why a metric cannot see the whole range.
 *
 *  - `retention` -- a sweep deletes rows past a fixed age. The floor moves daily.
 *  - `coverage`  -- nothing deletes, but the source only knows what it has
 *                   ingested; there is no history before it started recording.
 *  - `unbounded` -- the metric can speak to every day in the range.
 */
export interface ActivityHorizon {
  kind: 'retention' | 'coverage' | 'unbounded'
  /**
   * The oldest day this metric can be trusted for, `YYYY-MM-DD` in the requested
   * timezone. Every earlier day in the axis is `unavailable`.
   *
   * ABSENT means one of two opposite things, disambiguated by `kind`:
   * `unbounded` = no floor at all; `coverage` = the source is empty, so there is
   * no covered day and the whole range is `unavailable`.
   */
  sinceDay?: string
  /** Retention window in days. Only on `kind: 'retention'`. */
  retentionDays?: number
  /** One sentence for the pane to show when a viewer asks why it is grey. */
  note: string
}

export interface ActivityMetricSeries {
  metric: ActivityMetricId
  /** Display name. Server-side so the five metrics are named once, not twice. */
  label: string
  unit: 'count' | 'tokens' | 'usd'
  horizon: ActivityHorizon
  /** Same length and order as `ActivityMatrix.days`. */
  cells: ActivityCell[]
  /** Largest `value` over the ACTIVE cells -- the colour scale's denominator. 0
   *  when nothing is active, in which case the pane has no scale to draw. */
  max: number
  /** Sum over the active cells. */
  total: number
  /** How many cells are `active` -- lets the pane say "14 of 366 days". */
  activeDays: number
}

export interface ActivityMatrix {
  /** The IANA zone the days were bucketed in. Echoed back because the caller
   *  must be able to prove the server used the zone it asked for. */
  tz: string
  generatedAt: number
  /**
   * `commits` -- the only OUTPUT metric that is also the only one that can fill
   * the grid. Volume metrics go UP when an agent thrashes, so defaulting to one
   * would make a loop look like a good week.
   */
  defaultMetric: ActivityMetricId
  /** Oldest first. Length is the `days` the caller asked for. */
  days: ActivityAxisDay[]
  metrics: ActivityMetricSeries[]
}

/** Rolling 12 months, like GitHub's grid. 366 covers a leap year. */
export const ACTIVITY_DEFAULT_DAYS = 366

/** Two years. Past this the payload stops being one request's worth of grid. */
export const ACTIVITY_MAX_DAYS = 732

/** The metric the switch starts on. Declared here so the server's response and
 *  the pane's initial state cannot disagree. */
export const ACTIVITY_DEFAULT_METRIC: ActivityMetricId = 'commits'

/** Label + unit per metric, in the order the switch should show them: the two
 *  OUTPUT metrics first, the three VOLUME ones after. The ordering is the
 *  honesty rule made structural -- volume sits NEXT TO output, never instead. */
export const ACTIVITY_METRIC_META: ReadonlyArray<{
  id: ActivityMetricId
  label: string
  unit: ActivityMetricSeries['unit']
}> = [
  { id: 'commits', label: 'Commits', unit: 'count' },
  { id: 'cardsClosed', label: 'Cards closed', unit: 'count' },
  { id: 'turns', label: 'Turns', unit: 'count' },
  { id: 'tokens', label: 'Tokens', unit: 'tokens' },
  { id: 'usd', label: 'USD', unit: 'usd' },
]
