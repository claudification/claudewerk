/**
 * slow-query-config - environment wiring for the SQLite slow-query log.
 *
 * Kept apart from the instrumentation itself so that stays a pure, testable
 * unit with no environment reads in it.
 */

import { formatStatsSummary, type QueryStats } from './slow-query-log'

// The tests assert these names as literals on purpose: renaming a constant must
// not silently pass a test that reads the same constant back.
/** Log a query at or above this many ms. `0` switches instrumentation off. */
const SLOW_QUERY_MS_ENV = 'CLAUDWERK_SLOW_QUERY_MS'
/** How often to dump the aggregate top-N. `0` switches the summary off. */
const QUERY_STATS_INTERVAL_MS_ENV = 'CLAUDWERK_QUERY_STATS_INTERVAL_MS'

const DEFAULT_SLOW_QUERY_MS = 50
const DEFAULT_STATS_INTERVAL_MS = 0
const SUMMARY_TOP_N = 10

/**
 * Read a non-negative integer from the environment, falling back when it is
 * missing or malformed. A typo must never silently disable observability, so an
 * unparseable value keeps the default rather than becoming 0.
 */
export function readThreshold(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[slow-query] ignoring ${key}=${raw} (not a non-negative number), using ${fallback}`)
    return fallback
  }
  return Math.floor(parsed)
}

export function slowQueryThresholdMs(env: Record<string, string | undefined> = process.env): number {
  return readThreshold(env, SLOW_QUERY_MS_ENV, DEFAULT_SLOW_QUERY_MS)
}

export function queryStatsIntervalMs(env: Record<string, string | undefined> = process.env): number {
  return readThreshold(env, QUERY_STATS_INTERVAL_MS_ENV, DEFAULT_STATS_INTERVAL_MS)
}

/**
 * Start the periodic aggregate dump. Returns a stop function, or null when the
 * summary is disabled. Unref'd so it never holds the process open.
 */
export function startQueryStatsSummary(stats: QueryStats, intervalMs: number): (() => void) | null {
  if (intervalMs <= 0) return null
  const timer = setInterval(() => {
    const top = stats.top(SUMMARY_TOP_N)
    if (top.length > 0) console.log(formatStatsSummary(top))
    stats.reset()
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
