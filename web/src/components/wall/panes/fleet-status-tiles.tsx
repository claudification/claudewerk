/**
 * The hosts tile and the socket tile of P4.
 *
 * HOSTS comes off the one wall frame -- the same counters the broker already
 * computes per subscriber and scopes to the projects that subscriber may see.
 * There is no second count here and no fetch. Before the first frame lands the
 * store's picture is a zeroed struct, which is NOT the same statement as "zero
 * hosts", so the tile dashes until `frames > 0`.
 *
 * SOCKET is the deviation this pane had to make, and it is written down rather
 * than papered over. The mockup's tile is `WS RTT 14ms / 2 queued`; the card
 * points at `ws-stats.ts` for it. `ws-stats.ts` measures THROUGHPUT -- messages
 * and bytes per second over a 3s window -- and there is no application-level
 * ping/pong anywhere on this wire, so no round trip is measurable from the
 * browser today. The measured number therefore takes the headline (msg/s, which
 * is the liveness question a wall actually asks of a socket) and the round trip
 * takes the dash it has earned. `wall-ws-rtt-probe` is the card that would give
 * this tile a real latency feed.
 */

import { useSyncExternalStore } from 'react'
import { useWallChannel } from '@/hooks/use-wall-channel'
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

export function FleetSocket() {
  const rates = useSyncExternalStore(subscribeRates, getRates)
  const perSec = Math.round(rates.msgInPerSec + rates.msgOutPerSec)
  return <FleetKpi label="WS" value={String(perSec)} unit="/s" sub="— ms rtt (no probe)" />
}
