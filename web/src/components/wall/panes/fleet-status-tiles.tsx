/**
 * The hosts tile and the socket tile of P4.
 *
 * HOSTS comes off the one wall frame -- the same counters the broker already
 * computes per subscriber and scopes to the projects that subscriber may see.
 * There is no second count here and no fetch. Before the first frame lands the
 * store's picture is a zeroed struct, which is NOT the same statement as "zero
 * hosts", so the tile dashes until `frames > 0`.
 *
 * SOCKET is the mockup's tile: `WS RTT 14ms / 2 queued`. Every number in it is
 * measured. The round trip is a MEDIAN over a rolling window of real `ws_ping` /
 * `ws_pong` round trips (`ws-rtt.ts`), never a single sample; the queue depth is
 * the rAF flush backlog; `ws-stats.ts` still contributes the throughput, demoted
 * to the sub-line where it belongs now that the headline has the latency the
 * mockup asked for. The tile dashes until the first pong returns and dashes
 * again the moment the socket drops -- a latency for a wire that is down is the
 * one thing worse than no latency at all.
 *
 * The probe is held by THIS component: mounted -> one ping every 5 s, unmounted
 * -> nothing on the wire. An idle panel does not heartbeat the broker.
 */

import { useSyncExternalStore } from 'react'
import { useWallChannel } from '@/hooks/use-wall-channel'
import { useWsRtt } from '@/hooks/ws-rtt'
import { getRates, subscribe as subscribeRates } from '@/hooks/ws-stats'
import { FleetKpi } from './fleet-kpi'

export function FleetHosts() {
  const { fleet, frames } = useWallChannel()
  const seen = frames > 0
  return (
    <FleetKpi
      label="HOSTS UP"
      value={seen ? String(fleet.hosts) : null}
      sub={seen ? `${fleet.conversations} conversations` : 'no frame yet'}
    />
  )
}

/** Send-side backlog, shown only when there IS one -- `0 B out` on every tile
 *  forever would be noise, a non-zero value means this browser is the slow end. */
function outBacklog(bytes: number): string | null {
  if (bytes <= 0) return null
  return bytes < 1024 ? `${bytes} B out` : `${(bytes / 1024).toFixed(1)} KB out`
}

export function FleetSocket() {
  const rates = useSyncExternalStore(subscribeRates, getRates)
  const { medianMs, queued, bufferedBytes } = useWsRtt()
  const perSec = Math.round(rates.msgInPerSec + rates.msgOutPerSec)
  const sub = [`${queued} queued`, `${perSec}/s`, outBacklog(bufferedBytes)].filter(Boolean).join(' · ')
  return <FleetKpi label="WS RTT" value={medianMs == null ? null : String(medianMs)} unit="ms" sub={sub} />
}
