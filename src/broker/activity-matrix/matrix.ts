/**
 * THE ASSEMBLER -- five folds, five horizons, one response.
 *
 * This is where the honesty rules stop being prose and become branches:
 *
 *   - a day outside a metric's horizon is `unavailable`, never `empty`;
 *   - a day inside it with nothing in it is `empty`, and carries NO value, so
 *     there is no zero for a colour scale to accidentally paint;
 *   - a USD day carries the exact/estimated split it was folded from.
 *
 * ONE READ PER SOURCE, FIVE METRICS OUT. The pane's hover shows every metric's
 * number for the hovered day, so a response that carried one metric would cost
 * five requests for one hover. The `turns` table is read once and folded three
 * ways; the two ledgers are one query each.
 *
 * NO WRITES, NO SCHEMA. Every number here is derived at request time from tables
 * that already exist. Extending the 30-day horizon would take a daily rollup
 * table, which is new persisted schema and is deliberately NOT in this card --
 * the grid is honest and useful at 30 / 90 / since-install, and the default
 * metric is the one that can actually fill it.
 */

import {
  ACTIVITY_DEFAULT_METRIC,
  ACTIVITY_METRIC_META,
  type ActivityCell,
  type ActivityHorizon,
  type ActivityMatrix,
  type ActivityMetricId,
  type ActivityMetricSeries,
  type ActivityUsdProvenance,
} from '../../shared/activity-matrix'
import { CARD_MOVE_RETENTION_MS } from '../card-ledger-store'
import { COST_RETENTION_MS } from '../cost-retention'
import type { TurnActivityRow } from '../store/types'
import { buildDayAxis, type DayWindow, firstFullyCoveredDay } from './days'
import { foldInstants, foldTurns, type UsdDayTotals } from './folds'

/**
 * Where the numbers come from, as four plain functions.
 *
 * Injected rather than imported so the fold is testable without a broker: two of
 * the three sources are module-singleton SQLite handles that only exist after
 * `initCommitLedger` / `initCardLedgerStore`, and a timezone-bucketing test has
 * no business booting either.
 */
export interface ActivitySources {
  /** Every turn in [from, to], any order. */
  turns(from: number, to: number): TurnActivityRow[]
  /** Commit instants in [from, to]. */
  commits(from: number, to: number): number[]
  /** Oldest commit the ledger holds, or null when it holds none. */
  earliestCommitAt(): number | null
  /** Instants at which cards moved into `done`, in [from, to]. */
  cardCloses(from: number, to: number): number[]
}

export interface ActivityMatrixOptions {
  /** REQUIRED IANA zone. There is no default: a wrong guess here silently moves
   *  every evening's work onto the next square, which looks like data. */
  tz: string
  /** How many calendar days the axis covers, ending today in `tz`. */
  days: number
  /** Test seam. The rolling window ends on the local day containing this. */
  now?: number
}

/** A metric's per-day numbers plus the floor it can speak from. */
interface FoldedMetric {
  values: number[]
  horizon: ActivityHorizon
  usd?: UsdDayTotals[]
}

/** Retention floors expressed as a horizon over a given axis. `sinceDay` is the
 *  first day the sweep has NOT yet eaten into -- see `firstFullyCoveredDay`. */
function retentionHorizon(
  windows: readonly DayWindow[],
  now: number,
  retentionMs: number,
  note: string,
): ActivityHorizon {
  const retentionDays = Math.round(retentionMs / 86_400_000)
  const sinceDay = firstFullyCoveredDay(windows, now - retentionMs)
  return { kind: 'retention', retentionDays, ...(sinceDay ? { sinceDay } : {}), note }
}

/**
 * The commit ledger's floor, which is a COVERAGE floor rather than a retention
 * one: no sweep touches `commits.db`, but the ledger began at install and knows
 * nothing before it.
 *
 * `earliest === null` (an empty ledger) yields a `coverage` horizon with NO
 * `sinceDay`, which makes the whole range `unavailable`. That is the truthful
 * reading of an empty ledger -- "we have never recorded a commit" is not "no
 * commits were ever made".
 *
 * The known gap this does not model: an ingestion outage INSIDE the covered
 * range still reads as `empty`. Nothing in the ledger records that it stopped
 * listening, so there is nothing to read; git history is the only cure and that
 * is a backfill, not a fold.
 */
function commitHorizon(windows: readonly DayWindow[], earliest: number | null): ActivityHorizon {
  const note =
    earliest === null
      ? 'The commit ledger is empty -- no day in this range has been recorded.'
      : 'The commit ledger keeps everything, but it only knows what it has ingested since the git hook was installed.'
  if (earliest === null) return { kind: 'coverage', note }
  const sinceDay = firstFullyCoveredDay(windows, earliest)
  return { kind: 'coverage', ...(sinceDay ? { sinceDay } : {}), note }
}

/**
 * Is this day inside what the metric can speak to?
 *
 * The comparison is lexicographic on `YYYY-MM-DD`, which for that format is
 * exactly a chronological one, and it runs on the very strings the response
 * carries -- so whatever the pane compares, it compares what the server did.
 *
 * A `coverage` horizon with no `sinceDay` means the source is EMPTY, so no day
 * is covered. That is why the missing case answers false rather than defaulting
 * to permissive: an empty ledger must not report a year of idleness.
 */
function isCovered(day: string, horizon: ActivityHorizon): boolean {
  if (horizon.kind === 'unbounded') return true
  if (horizon.sinceDay === undefined) return false
  return day >= horizon.sinceDay
}

/** Which of the two numbers the day's cost came from. */
function provenanceOf(split: UsdDayTotals): ActivityUsdProvenance {
  if (split.exactUsd > 0 && split.estimatedUsd > 0) return 'mixed'
  return split.estimatedUsd > 0 ? 'estimated' : 'exact'
}

/** One day's cell. Split out of the map callback purely so each of the three
 *  states reads as one line rather than as a rung of nested ternaries. */
function cellFor(day: string, value: number, horizon: ActivityHorizon, split?: UsdDayTotals): ActivityCell {
  if (!isCovered(day, horizon)) return { state: 'unavailable' }
  if (value <= 0) return { state: 'empty' }
  if (!split) return { state: 'active', value }
  return {
    state: 'active',
    value,
    usd: { provenance: provenanceOf(split), exactUsd: split.exactUsd, estimatedUsd: split.estimatedUsd },
  }
}

function toCells(
  windows: readonly DayWindow[],
  values: readonly number[],
  horizon: ActivityHorizon,
  usd?: readonly UsdDayTotals[],
): ActivityCell[] {
  return windows.map((w, i) => cellFor(w.day, values[i] ?? 0, horizon, usd?.[i]))
}

function summarize(cells: readonly ActivityCell[]): { max: number; total: number; activeDays: number } {
  let max = 0
  let total = 0
  let activeDays = 0
  for (const cell of cells) {
    if (cell.state !== 'active' || cell.value === undefined) continue
    activeDays++
    total += cell.value
    if (cell.value > max) max = cell.value
  }
  return { max, total, activeDays }
}

function seriesFor(id: ActivityMetricId, windows: readonly DayWindow[], folded: FoldedMetric): ActivityMetricSeries {
  const meta = ACTIVITY_METRIC_META.find(m => m.id === id)
  if (!meta) throw new Error(`activity-matrix: no metadata for metric ${id}`)
  const cells = toCells(windows, folded.values, folded.horizon, folded.usd)
  return { metric: id, label: meta.label, unit: meta.unit, horizon: folded.horizon, cells, ...summarize(cells) }
}

const TURN_NOTE = 'Turns are swept at 30 days; anything older is gone from SQLite, not idle.'

/**
 * Build the whole matrix.
 *
 * The source window is the axis's own span -- from the first day's local
 * midnight to the last day's exclusive end -- so a query never asks a table for
 * rows the grid has nowhere to draw. The horizons are computed against the same
 * `now` the axis was built from, so a request that straddles midnight cannot end
 * up with an axis from today and a floor from yesterday.
 */
export function buildActivityMatrix(sources: ActivitySources, options: ActivityMatrixOptions): ActivityMatrix {
  const now = options.now ?? Date.now()
  const windows = buildDayAxis(now, options.days, options.tz)
  const from = windows[0]?.startMs ?? now
  const to = (windows[windows.length - 1]?.endMs ?? now) - 1

  const turnFold = foldTurns(sources.turns(from, to), windows)
  const turnHorizon = retentionHorizon(windows, now, COST_RETENTION_MS, TURN_NOTE)
  const usdValues = turnFold.usd.map(u => u.exactUsd + u.estimatedUsd)

  const folded: Record<ActivityMetricId, FoldedMetric> = {
    commits: {
      values: foldInstants(sources.commits(from, to), windows),
      horizon: commitHorizon(windows, sources.earliestCommitAt()),
    },
    cardsClosed: {
      values: foldInstants(sources.cardCloses(from, to), windows),
      horizon: retentionHorizon(
        windows,
        now,
        CARD_MOVE_RETENTION_MS,
        'Board moves are swept at 90 days; earlier days were never kept.',
      ),
    },
    turns: { values: turnFold.turns, horizon: turnHorizon },
    tokens: { values: turnFold.tokens, horizon: { ...turnHorizon } },
    usd: { values: usdValues, horizon: { ...turnHorizon }, usd: turnFold.usd },
  }

  return {
    tz: options.tz,
    generatedAt: now,
    defaultMetric: ACTIVITY_DEFAULT_METRIC,
    days: windows.map(w => ({ day: w.day, dow: w.dow })),
    // Driven by the metadata list so the response order IS the switch order --
    // output metrics first, volume alongside rather than instead.
    metrics: ACTIVITY_METRIC_META.map(m => seriesFor(m.id, windows, folded[m.id])),
  }
}
