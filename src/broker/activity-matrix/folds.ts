/**
 * THE FIVE FOLDS -- source rows in, one number per day out.
 *
 * Each fold does exactly one thing: walk a list of instants (plus, for the cost
 * fold, the numbers attached to them) against a prebuilt day axis and add them
 * up. Nothing here knows about horizons, cell states or the wire shape; that is
 * `matrix.ts`. Nothing here knows about SQL either -- the sources arrive as
 * plain functions, which is what makes a Bangkok-midnight test a unit test
 * rather than a database fixture.
 *
 * WHY THE FOLDS ARE NOT SQL `GROUP BY`. SQLite has no IANA timezone database.
 * It can bucket by UTC day or by a fixed `'+07:00'` offset, and the second one
 * is a trap: it is right for Bangkok and silently wrong for every zone that
 * observes DST, which is most of them. The projection has to happen where
 * `Intl` is, so it happens here.
 *
 * A NOTE ON WHERE THE COST NUMBERS COME FROM. There is a materialised
 * `hourly_stats` rollup next to the raw `turns` table, and reading it would be
 * cheaper. Two reasons this reads the raw rows instead:
 *
 *   1. `costs.pruneOlderThan()` deletes from `turns` AND `hourly_stats` in the
 *      same call at the same cutoff (`broker/index.ts`), so the rollup does not
 *      outlive the rows it summarises. It buys no horizon.
 *   2. `hourly_stats` is keyed by UTC HOUR. India (+05:30), Nepal (+05:45) and
 *      Chatham (+12:45) all cross local midnight mid-hour, so an hour bucket
 *      there belongs to two local days and there is no honest way to split it
 *      after the fact. Raw rows carry the exact instant and have no such edge.
 */

import type { TurnActivityRow } from '../store/types'
import { type DayWindow, windowIndexFor } from './days'

/** One day's cost, split by how the number was arrived at. */
export interface UsdDayTotals {
  exactUsd: number
  estimatedUsd: number
}

/** What one pass over the `turns` table yields for all three cost metrics. The
 *  endpoint returns five metrics in one response, so the table is read once. */
export interface TurnFoldResult {
  /** Turn count per day. */
  turns: number[]
  /** input+output+cache tokens per day. */
  tokens: number[]
  /** Cost per day, kept split so provenance survives the fold. */
  usd: UsdDayTotals[]
}

function zeros(n: number): number[] {
  return new Array(n).fill(0)
}

/**
 * Count instants per day.
 *
 * Anything landing outside the axis is DROPPED, not clamped to the nearest end.
 * A commit dated 2019 (a rewritten author date, a bad clock on a build box) is
 * not evidence about the oldest square on the grid, and a row dated tomorrow is
 * not evidence about today.
 */
export function foldInstants(instants: readonly number[], windows: readonly DayWindow[]): number[] {
  const out = zeros(windows.length)
  for (const ms of instants) {
    const i = windowIndexFor(windows, ms)
    if (i >= 0) out[i]++
  }
  return out
}

/**
 * Fold the turns table into all three of its metrics at once.
 *
 * `exactCost` is carried per row rather than reduced to a per-day boolean: a day
 * that mixes headless (measured) and PTY (priced from tokens) conversations is
 * routine, and the only honest report of such a day is both numbers plus the
 * word `mixed`. Collapsing it early would force the pane to either label the
 * whole day estimated (understating what we know) or measured (overstating it).
 */
export function foldTurns(rows: readonly TurnActivityRow[], windows: readonly DayWindow[]): TurnFoldResult {
  const turns = zeros(windows.length)
  const tokens = zeros(windows.length)
  const usd: UsdDayTotals[] = windows.map(() => ({ exactUsd: 0, estimatedUsd: 0 }))

  for (const row of rows) {
    const i = windowIndexFor(windows, row.timestamp)
    if (i < 0) continue
    turns[i]++
    tokens[i] += row.tokens
    if (row.exactCost) usd[i].exactUsd += row.costUsd
    else usd[i].estimatedUsd += row.costUsd
  }

  return { turns, tokens, usd }
}
