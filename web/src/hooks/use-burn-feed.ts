/**
 * A2's historical feed: three EXISTING broker aggregations, read as they are,
 * over the period the wall is scoped to.
 *
 * - `/api/stats/hourly`   -> `store.costs.queryHourly()`, the Anthropic side, per
 *                            (hour, account, model, project). The per-project
 *                            split is a fold over these rows, and TODAY is a fold
 *                            over the same rows from local midnight.
 * - `/api/stats/summary`  -> `store.costs.querySummary()`, for the 30-day total
 *                            the cap is measured against.
 * - `/api/stats/openrouter` -> `querySpendRollup()`, the by-FEATURE side, which
 *                            `wall-openrouter-spend-store` made queryable.
 *
 * THE PERIOD MOVES TWO OF THE THREE. The project split and the OpenRouter split
 * both re-read at the selected window; the 30D summary does NOT, and neither
 * does TODAY. Those two are the tiles, they are fixed anchors on purpose, and
 * `a2-burn.tsx`'s header says why -- a cap measured against a 1h spend would
 * report 3% of a monthly ceiling and read as safety.
 *
 * `1m` IS `30d` ON THE WIRE. The wall's vocabulary and the broker's are not the
 * same list, and the store already has a name for the retention bound. Aliasing
 * `1m` in the broker would give one window two names; mapping it here keeps the
 * UI free to call it whatever a human reads fastest.
 *
 * THIRTY DAYS, NOT A CALENDAR MONTH. Both stores prune at 30 days
 * (`COST_RETENTION_MS`, `RETENTION_MS`), so a calendar-month tile would be
 * missing its first days for most of the month while looking complete. The tile
 * says `30D` because that is the window the data actually covers, and `1m` is
 * the longest period the selector offers for the same reason.
 *
 * `1h` IS THE LAST COMPLETE HOUR. `hourly_stats` deliberately excludes the hour
 * in progress (`materializeHourly`), and the route floors `from` to an hour key,
 * so a 1h ask returns exactly one finished bucket. That is the finest honest
 * grain this feed has; the number that IS live is the rate, and it rides the wall
 * channel with no fetch at all.
 *
 * THE THREE FETCHES ARE INDEPENDENT. Each lands in its own slot and a failure
 * leaves that slot `null` -- which the pane renders as a dash. One 403 from an
 * admin-only route must not blank the two numbers the viewer is allowed to see,
 * and no failure may ever degrade into a plausible zero.
 *
 * A poll, not a socket, on purpose: these are hour-grained aggregates that move
 * once an hour.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type BurnFeatureRow, type BurnHourlyRow, startOfHour, startOfLocalDay } from '@/lib/wall/burn-splits'
import { WALL_PERIOD_MS, type WallPeriod } from '@/lib/wall/period-store'
import { pullFeed } from '@/lib/wall/revive-store'
import { useWallRevive } from '@/lib/wall/use-wall-revive'
import { useConversationsStore } from './use-conversations'

/**
 * How often the historical half is re-read. Hourly buckets do not move faster,
 * and it is ONE number for every period on purpose: `useWallRevive` re-registers
 * the feed whenever this value changes, so a per-period clock would force a
 * second pull on top of the period change's own -- two fetches for one click.
 *
 * The cost of that choice is real and worth naming: a `1m` fold asks for thirty
 * times the rows a `24h` fold does, on the same minute clock. Trimming that is
 * `wall-stats-hourly-payload-at-long-windows`, not this card.
 */
const BURN_REFRESH_MS = 60_000

/** The wall's period as the OpenRouter route's `?period=`. Only the longest one
 *  differs; see the header. */
function spendPeriodParam(period: WallPeriod): string {
  return period === '1m' ? '30d' : period
}

/**
 * How far back the HOURLY pull reaches: the selected window, or local midnight,
 * whichever is EARLIER.
 *
 * The rows serve two readers with different windows. The project split wants the
 * period; the TODAY tile wants the calendar day and is a fixed anchor that must
 * not shrink because somebody picked `1h`. Fetching the union and letting each
 * reader snap its own boundary keeps one request and keeps the tile honest --
 * pulling only the period would have made TODAY silently mean "today, or the
 * last hour of it, depending on a control that does not claim to touch it".
 *
 * The period edge is snapped to the hour grid the same way the route snaps
 * `?from=`, so `1h` lands on a whole bucket instead of mid-bucket. Local midnight
 * is already a bucket boundary in every whole-hour timezone and is left alone.
 */
function burnHourlyFrom(now: number, period: WallPeriod): number {
  return Math.min(startOfHour(now - WALL_PERIOD_MS[period]), startOfLocalDay(now))
}

export interface BurnFeed {
  /** Hourly cost rows over the selected period. `null` = never arrived. */
  hourly: BurnHourlyRow[] | null
  /** 30-day total spend -- a FIXED anchor, not period-relative. `null` = never arrived. */
  monthUsd: number | null
  /** OpenRouter by-feature rollup over the selected period. `null` = never arrived. */
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
 * Read the three feeds on mount, on every reconnect, on every period change, and
 * every `refreshMs`.
 *
 * The poll and the reconnect pull belong to `useWallRevive`: this hook owns the
 * three requests and nothing about WHEN they happen -- except the period change,
 * which is the one trigger the revive seam cannot see. A period change is not a
 * refresh, it is a different question, so the previous answer is DROPPED rather
 * than left on screen: for the moment before the new one lands the pane shows
 * dashes, which is what it shows for any number it does not have. Keeping the
 * old rows would print a 24h fold under a `1h` header, which is the exact lie
 * every dash in this pane exists to refuse.
 */
export function useBurnFeed(period: WallPeriod, refreshMs: number = BURN_REFRESH_MS): BurnFeed {
  const [feed, setFeed] = useState<BurnFeed>(EMPTY)

  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const from = burnHourlyFrom(Date.now(), period)
    const [hourly, summary, openrouter] = await Promise.all([
      getJson<BurnHourlyRow[]>(`/api/stats/hourly?from=${from}`),
      getJson<{ totalCostUsd: number }>('/api/stats/summary?period=30d'),
      getJson<{ byFeature: BurnFeatureRow[] }>(`/api/stats/openrouter?period=${spendPeriodParam(period)}`),
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
  }, [period])

  const { stale } = useWallRevive('burn', load, refreshMs)

  // The FIRST period is not a change -- the revive seam already pulls on mount,
  // and forcing a second pull for it would double every wall open.
  const seen = useRef(period)
  const connectSeq = useConversationsStore(s => s.connectSeq)
  useEffect(() => {
    if (seen.current === period) return
    seen.current = period
    setFeed(EMPTY)
    void pullFeed('burn', connectSeq, true)
  }, [period, connectSeq])

  // Memoised, not spread per render: A2 folds this object in three `useMemo`s and
  // a fresh identity every render would rebuild all three for nothing.
  return useMemo(() => (feed.stale === stale ? feed : { ...feed, stale }), [feed, stale])
}
