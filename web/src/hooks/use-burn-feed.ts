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

import { useEffect, useState } from 'react'
import type { BurnFeatureRow, BurnHourlyRow } from '@/lib/wall/burn-splits'

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
}

const EMPTY: BurnFeed = { hourly: null, monthUsd: null, features: null, settled: false }

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** Read the three feeds once, then every `BURN_REFRESH_MS`. */
export function useBurnFeed(refreshMs: number = BURN_REFRESH_MS): BurnFeed {
  const [feed, setFeed] = useState<BurnFeed>(EMPTY)

  useEffect(() => {
    let live = true

    const load = async () => {
      const from = Date.now() - HOURLY_WINDOW_MS
      const [hourly, summary, openrouter] = await Promise.all([
        getJson<BurnHourlyRow[]>(`/api/stats/hourly?from=${from}`),
        getJson<{ totalCostUsd: number }>('/api/stats/summary?period=30d'),
        getJson<{ byFeature: BurnFeatureRow[] }>('/api/stats/openrouter?period=24h'),
      ])
      if (!live) return
      setFeed({
        hourly: Array.isArray(hourly) ? hourly : null,
        monthUsd: typeof summary?.totalCostUsd === 'number' ? summary.totalCostUsd : null,
        features: Array.isArray(openrouter?.byFeature) ? openrouter.byFeature : null,
        settled: true,
      })
    }

    void load()
    const timer = setInterval(() => void load(), refreshMs)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [refreshMs])

  return feed
}
