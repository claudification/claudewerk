/**
 * WHAT A2 COSTS PER MINUTE, MEASURED.
 *
 * `wall-stats-default-window` gave A2 a window selector and left ONE refresh
 * clock behind it, so picking `1m` re-read thirty days of `/api/stats/hourly`
 * rows every sixty seconds where `24h` read one day's worth -- thirty times the
 * bytes a minute, to redraw bars that cannot have moved.
 *
 * These tests do not read `BURN_REFRESH_MS` and check the arithmetic. They stand
 * up a route whose response size is proportional to the window asked for -- which
 * is what `hourly_stats` actually is, one row per `(hour, account, model,
 * project_uri, sentinel_id, profile)` that billed -- run the hook against it on a
 * fake clock, and COUNT THE BYTES. A table can be right and the hook can still
 * ignore it (`ensureFeedPoll` used to do exactly that: it took the new interval
 * and bailed on `if (rec.timer) return`). Bytes on the wire cannot lie about it.
 *
 * TWO CLAIMS, and the second is the trap the card was written about:
 *
 *  1. NO WINDOW COSTS MORE PER MINUTE THAN `24h` DID. Measured on the RECURRING
 *     traffic -- the poll -- because the first pull is not optional: a reader who
 *     asks for thirty days has to be sent thirty days once. The bug was the
 *     *every sixty seconds* part.
 *  2. ONE CLICK, ONE PULL. A per-window clock means `refreshMs` changes when the
 *     period does, and `useWallRevive` used to list it in the deps of the effect
 *     that FETCHES -- so the naive version of this fix fires the period change's
 *     own pull AND a second one from re-registering the feed.
 */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WALL_PERIOD_MS, WALL_PERIODS, type WallPeriod } from '@/lib/wall/period-store'
import { feedPollMs, feedPulls, resetWallRevive } from '@/lib/wall/revive-store'
import { burnRefreshMs, useBurnFeed } from './use-burn-feed'
import { useConversationsStore } from './use-conversations'

/** Distinct `(account, model, project)` tuples billing in every hour. The row
 *  count is `hours * this`, which is the whole reason a wider window is a bigger
 *  body. The number itself does not matter; that it is per-HOUR does. */
const TUPLES_PER_HOUR = 6

/** Bytes of `/api/stats/hourly` body served so far. The meter. */
let hourlyBytes = 0

/** Whole hours the caller asked for, from the `?from=` the hook computed. */
function hoursAsked(url: string): number {
  const from = Number(new URL(url, 'http://wall.test').searchParams.get('from'))
  if (!Number.isFinite(from)) return 0
  return Math.max(0, Math.round((Date.now() - from) / 3_600_000))
}

function hourlyBody(url: string): unknown[] {
  const from = Date.now() - hoursAsked(url) * 3_600_000
  const rows: unknown[] = []
  for (let h = 0; h < hoursAsked(url); h++) {
    const hour = new Date(from + h * 3_600_000).toISOString()
    for (let t = 0; t < TUPLES_PER_HOUR; t++) {
      rows.push({ hour, projectUri: `claude://default/p${t}`, model: `m${t}`, account: `a${t}`, costUsd: 0.5 })
    }
  }
  return rows
}

function stubStats(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/hourly')) {
        const rows = hourlyBody(url)
        hourlyBytes += JSON.stringify(rows).length
        return { ok: true, status: 200, json: async () => rows }
      }
      if (url.includes('/summary')) return { ok: true, status: 200, json: async () => ({ totalCostUsd: 15_500 }) }
      return { ok: true, status: 200, json: async () => ({ byFeature: [] }) }
    }),
  )
}

/** Let every in-flight fetch land without moving the clock. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  hourlyBytes = 0
  resetWallRevive()
  useConversationsStore.setState({ connectSeq: 1 })
  stubStats()
})

afterEach(() => {
  cleanup()
  resetWallRevive()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/**
 * Bytes the POLL costs this window, per minute of wall time.
 *
 * The mount pull is excluded on purpose: it is the price of the question, not of
 * the clock, and no fix to a refresh interval can make it smaller. Everything
 * after it is what the card calls "every sixty seconds".
 */
async function pollBytesPerMinute(period: WallPeriod, minutes: number): Promise<number> {
  const view = renderHook(() => useBurnFeed(period))
  await settle()
  const afterMount = hourlyBytes

  await act(async () => {
    await vi.advanceTimersByTimeAsync(minutes * 60_000)
  })
  const cost = (hourlyBytes - afterMount) / minutes
  view.unmount()
  resetWallRevive()
  return cost
}

it('costs no more per minute at any window than 24h did -- measured on the wire', async () => {
  // An hour of wall time: 60 ticks at the minute clock, 2 at the half-hour one.
  const MINUTES = 60
  const baseline = await pollBytesPerMinute('24h', MINUTES)
  // The stub must actually be charging for the window, or every assertion below
  // passes on a route that serves nothing.
  expect(baseline).toBeGreaterThan(0)

  const measured: Record<string, number> = {}
  for (const period of WALL_PERIODS) measured[period] = await pollBytesPerMinute(period, MINUTES)

  for (const period of WALL_PERIODS) {
    expect(measured[period], `${period} poll bytes/min vs the 24h baseline`).toBeLessThanOrEqual(baseline)
  }

  // And the one the card is actually about: `1m` reads thirty times the rows, so
  // an unchanged clock would have shown up here as thirty times the baseline.
  expect(measured['1m']).toBeLessThanOrEqual(baseline)
})

it('holds the SHAPE of the fix: hours-asked-for per second of clock never exceeds 24h', () => {
  const budget = WALL_PERIOD_MS['24h'] / burnRefreshMs('24h')
  for (const period of WALL_PERIODS) {
    expect(WALL_PERIOD_MS[period] / burnRefreshMs(period), `${period} window-per-clock`).toBeLessThanOrEqual(budget)
  }
})

it('fires exactly ONE pull for a period change across the clock boundary', async () => {
  const view = renderHook(({ period }: { period: WallPeriod }) => useBurnFeed(period), {
    initialProps: { period: '24h' as WallPeriod },
  })
  await settle()
  expect(feedPulls('burn')).toBe(1)
  expect(feedPollMs('burn')).toBe(60_000)

  // 24h -> 3d is the boundary the card names: the window changes AND so does the
  // refresh clock. Two pulls here is the bug this test exists to catch.
  view.rerender({ period: '3d' })
  await settle()
  expect(feedPulls('burn')).toBe(2)
  expect(feedPollMs('burn')).toBe(burnRefreshMs('3d'))
})

it('fires exactly one pull per click walking the whole selector', async () => {
  const view = renderHook(({ period }: { period: WallPeriod }) => useBurnFeed(period), {
    initialProps: { period: '1h' as WallPeriod },
  })
  await settle()

  let expected = 1
  for (const period of ['6h', '24h', '3d', '7d', '1m', '24h', '1h'] as WallPeriod[]) {
    view.rerender({ period })
    await settle()
    expected++
    expect(feedPulls('burn'), `after picking ${period}`).toBe(expected)
    expect(feedPollMs('burn'), `clock after picking ${period}`).toBe(burnRefreshMs(period))
  }
})

it('re-rendering at an unchanged period pulls nothing at all', async () => {
  const view = renderHook(({ period }: { period: WallPeriod }) => useBurnFeed(period), {
    initialProps: { period: '1m' as WallPeriod },
  })
  await settle()
  expect(feedPulls('burn')).toBe(1)

  for (let i = 0; i < 5; i++) view.rerender({ period: '1m' })
  await settle()
  expect(feedPulls('burn')).toBe(1)
})

it('keeps polling after a reconnect -- the hold cycle must not lose the clock', async () => {
  // Splitting the clock out of the fetching effect put a hazard here: a reconnect
  // releases and re-acquires the feed, which stops the timer, and only the clock
  // effect re-running can start it again. If it did not, a wall that survived one
  // broker restart would go on showing an ever-older number and never re-read.
  renderHook(() => useBurnFeed('24h'))
  await settle()
  const afterMount = feedPulls('burn')

  await act(async () => {
    useConversationsStore.setState({ connectSeq: 2 })
    await vi.advanceTimersByTimeAsync(0)
  })
  const afterReconnect = feedPulls('burn')
  expect(afterReconnect).toBe(afterMount + 1)
  expect(feedPollMs('burn')).toBe(60_000)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(3 * 60_000)
  })
  expect(feedPulls('burn')).toBe(afterReconnect + 3)
})
