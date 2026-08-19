/**
 * The two token tiles of P4, each owning its OWN subscription.
 *
 * That ownership is the point: the ring notifies at ~1 Hz and the 24h total
 * refetches every 5 minutes, and neither should drag the hosts tile, the socket
 * tile or the pane's filter through a re-render. The pane renders the grid; a
 * tile renders itself.
 *
 * NEITHER TILE SEEDS THE RING. `seedRing()` appends unconditionally, so a second
 * caller (the header's TokenFlowBar already calls it on mount) would double every
 * seeded bucket -- a wall showing twice the real rate is exactly the fiction this
 * pane exists to refuse. P4 reads whatever is in the ring and shows a dash when
 * that is nothing.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { formatTokens, StackedBars } from '@/components/token-flow-bar'
import { fetchWindow, getSamples, getVersion, subscribe } from '@/hooks/token-flow-store'
import { tokenRate } from '@/lib/wall/fleet-rate'
import { FleetKpi } from './fleet-kpi'

/** The 24h total is a server aggregate; nothing pushes it, so it is pulled. */
const DAY_REFRESH_MS = 5 * 60_000

export function FleetTokenRate() {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  const { buckets, perMinute } = tokenRate(getSamples(), Date.now())
  return (
    <FleetKpi label="TOKENS/MIN" value={perMinute == null ? null : formatTokens(perMinute)} sub="in + out, last 2m">
      {buckets.length > 0 && (
        <div className="wall-kpi-spark">
          <StackedBars buckets={buckets} width={108} height={22} />
        </div>
      )}
    </FleetKpi>
  )
}

/** Rolling 24h, NOT calendar-today: `/api/stats/tokens` windows are lookbacks
 *  and there is no midnight-anchored endpoint. The label says 24H so the number
 *  is not read as something it is not. */
export function FleetTokensDay() {
  const [total, setTotal] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => {
      fetchWindow('1d', 'global')
        .then(r => {
          if (!alive) return
          setTotal(r.buckets.reduce((n, b) => n + b.inputTokens + b.outputTokens, 0))
        })
        // Left at whatever we last knew (null on a cold failure) -- a failed
        // fetch must not become a zero.
        .catch(() => {})
    }
    load()
    const t = setInterval(load, DAY_REFRESH_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  return <FleetKpi label="TOKENS 24H" value={total == null ? null : formatTokens(total)} sub="in + out, rolling" />
}
