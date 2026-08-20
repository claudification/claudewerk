/**
 * P4 FLEET -- four KPI tiles, and every number in them measured.
 *
 * The pane is a grid and a filter, nothing else. Each tile owns its own feed and
 * its own subscription (`fleet-token-tiles`, `fleet-status-tiles`), so the ring's
 * 1 Hz tick redraws one sparkline instead of the whole pane, and a wall frame
 * redraws one counter instead of four.
 *
 * FILTER. The axes declared here are `text`, and the rows are THE TILES. Every
 * number on this pane is a fleet-wide aggregate: a token bucket has no project,
 * a broker-side counter has no band, and a socket rate has no cost. Declaring
 * `host` was considered and rejected -- the ring carries `sentinelId` so two
 * tiles could honour `&studio`, but the 24h server total and the socket rate
 * cannot, and a filter that silently bites half a pane is the fiction this card
 * exists to refuse. So `text` is the one constraint the pane can honour
 * completely; every other axis is stripped before a tile is looked at and the
 * pane stays FULL under it. `{matched}/{total}` is tiles shown over tiles.
 *
 * There is no project dot or chip on this pane, so the store's chip action has
 * nothing to bind to here.
 */

import { useWallFilter, type WallAxis } from '@/lib/wall/filter'
import { fleetReport } from '@/lib/wall/stat-reports'
import { useWallReportView } from '@/lib/wall/use-wall-report-view'
import { WallPane } from '../wall-pane'
import { wallReadings } from '../wall-reading-bus'
import { FLEET_READING_PREFIX } from './fleet-kpi'
import { FleetHosts, FleetSocket } from './fleet-status-tiles'
import { FleetTokenRate, FleetTokensDay } from './fleet-token-tiles'

const AXES: readonly WallAxis[] = ['text']

/** Order is the mockup's: rate, day total, hosts, socket. */
const TILES = [
  { key: 'tokens-min', label: 'TOKENS/MIN', Tile: FleetTokenRate },
  { key: 'tokens-day', label: 'TOKENS 24H', Tile: FleetTokensDay },
  { key: 'hosts', label: 'HOSTS UP', Tile: FleetHosts },
  { key: 'socket', label: 'WS RTT', Tile: FleetSocket },
] as const

export default function FleetPane() {
  const { rows, matched, total } = useWallFilter(TILES, AXES, t => ({ title: t.label }))
  const view = useWallReportView()

  return (
    // The report reads what the TILES published, at click time -- the pane holds
    // none of the four numbers and must not start re-deriving them.
    <WallPane
      title="FLEET"
      code="P4"
      count={`${matched}/${total}`}
      report={() => fleetReport(wallReadings(FLEET_READING_PREFIX), view)}
    >
      {rows.length === 0 ? (
        <p className="wall-kpi-none">no tile matches the filter</p>
      ) : (
        <div className="wall-kpis">
          {rows.map(({ key, Tile }) => (
            <Tile key={key} />
          ))}
        </div>
      )}
    </WallPane>
  )
}
