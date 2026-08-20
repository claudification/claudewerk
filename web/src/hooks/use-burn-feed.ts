/**
 * A2's historical feed: three EXISTING broker aggregations, read as they are.
 *
 * - `/api/stats/hourly`   -> `store.costs.queryHourly()`, the Anthropic side, per
 *                            (hour, account, model, project). Today's total and
 *                            the per-project split are folds over these rows.
 * - `/api/stats/summary`  -> `store.costs.querySummary()`, for the 30-day total
 *                            the cap is measured against.
 * - `/api/stats/openrouter` -> `querySpendRollup()`, the by-FEATURE side, which
 *                            `wall-openrouter-spend-store` made queryable.
 *
 * THIRTY DAYS, NOT A CALENDAR MONTH. Both stores prune at 30 days
 * (`COST_RETENTION_MS`, `RETENTION_MS`), so a calendar-month tile would be
 * missing its first days for most of the month while looking complete. The tile
 * says `30D` because that is the window the data actually covers.
 *
 * THE THREE FETCHES ARE INDEPENDENT. Each lands in its own slot and a failure
 * leaves that slot `null` -- which the pane renders as a dash. One 403 from an
 * admin-only route must not blank the two numbers the viewer is allowed to see,
 * and no failure may ever degrade into a plausible zero.
 *
 * A poll, not a socket, on purpose: these are 24h and 30d aggregates that move
 * once an hour. The number that has to be LIVE is the rate, and that one rides
 * the wall channel (`burn.ts`) with no fetch at all.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BurnFeatureRow, BurnHourlyRow } from '@/lib/wall/burn-splits'
import { useWallRevive } from '@/lib/wall/use-wall-revive'

/** How often the historical half is re-read. Hourly buckets do not move faster. */
const BURN_REFRESH_MS = 60_000

/** The window the splits and today's total are folded from. */
const HOURLY_WINDOW_MS = 24 * 60 * 60_000

export interface BurnFeed {
  /** Hourly cost rows over the last 24h. `null` = never arrived. */
  hourly: BurnHourlyRow[] | null
  /** 30-day total spend. `null` = never arrived. */
  monthUsd: number | null
  /** OpenRouter by-feature rollup over 24h. `null` = never arrived. */
  features: BurnFeatureRow[] | null
  /** True once every fetch has settled at least once, however it settled. */
  settled: boolean
  /** The numbers above landed on an EARLIER connection than the one we are on.
   *  They are the last thing we knew, not the current thing. */
  stale: boolean
}

const EMPTY: BurnFeed = { hourly: null, monthUsd: null, features: null, settled: false, stale: false }

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/**
 * Read the three feeds on mount, on every reconnect, and every `refreshMs`.
 *
 * The poll and the reconnect pull both belong to `useWallRevive` now: this hook
 * owns the three requests and nothing about WHEN they happen. Before that, a
 * broker restart left A2's 24h and 30d numbers frozen for up to a minute with
 * nothing saying so.
 */
export function useBurnFeed(refreshMs: number = BURN_REFRESH_MS): BurnFeed {
  const [feed, setFeed] = useState<BurnFeed>(EMPTY)

  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const from = Date.now() - HOURLY_WINDOW_MS
    const [hourly, summary, openrouter] = await Promise.all([
      getJson<BurnHourlyRow[]>(`/api/stats/hourly?from=${from}`),
      getJson<{ totalCostUsd: number }>('/api/stats/summary?period=30d'),
      getJson<{ byFeature: BurnFeatureRow[] }>('/api/stats/openrouter?period=24h'),
    ])
    if (!live.current) return false
    setFeed({
      hourly: Array.isArray(hourly) ? hourly : null,
      monthUsd: typeof summary?.totalCostUsd === 'number' ? summary.totalCostUsd : null,
      features: Array.isArray(openrouter?.byFeature) ? openrouter.byFeature : null,
      settled: true,
      stale: false,
    })
    // THE PULL LANDED IF ANY OF THE THREE DID. One 403 on an admin-only route is
    // an ordinary partial view (see the header comment); all three null is a
    // broker that did not answer, and that is exactly what stale means.
    return hourly !== null || summary !== null || openrouter !== null
  }, [])

  const { stale } = useWallRevive('burn', load, refreshMs)

  // Memoised, not spread per render: A2 folds this object in three `useMemo`s and
  // a fresh identity every render would rebuild all three for nothing.
  return useMemo(() => (feed.stale === stale ? feed : { ...feed, stale }), [feed, stale])
}
