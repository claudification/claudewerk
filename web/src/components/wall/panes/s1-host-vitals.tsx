/**
 * S1 HOST VITALS -- cpu / ram / disk per node.
 *
 * Feed: the `hosts` section of the one `wall` frame, produced by the broker from
 * the node-stats frames the sentinel already sends on its existing socket. This
 * pane opens no connection, polls nothing and samples nothing.
 *
 * ONE ROW PER NODE, not per host. Two agents on one box report the same machine
 * facts and different conversation counts; collapsing them here would throw away
 * the half that differs. The node-stats contract's `dedupeMachineStatsByHost` is
 * the tool for a per-HOST view and this is not one.
 *
 * FILTER: `text` (the node name) and `&host`. Deliberately NOT `~time` -- a live
 * node's sample is always seconds old so a window would drop nothing, while a
 * stale node would disappear from the one pane whose job is to show that it went
 * quiet.
 *
 * THE TIME CURSOR IS THEREFORE ANSWERED HERE, not by `useWallFilter`: not
 * declaring `~time` is exactly the statement that these rows have no per-row
 * clock to narrow on. What they DO have is `cpuHistory`, five minutes of it, so
 * a rewind reads the ring at the offset and drops the nodes whose ring does not
 * go back that far -- `hostVitalsAtCursor` owns that rule and is tested apart
 * from this component.
 */

import { useMemo } from 'react'
import { useWallChannel } from '@/hooks/use-wall-channel'
// Through the barrel: `filter.ts` is the surface every pane imports, so the
// substrate can move a file without eleven panes noticing.
import { useWallFilter, type WallAxis } from '@/lib/wall/filter'
import { hostVitalsAtCursor, hostVitalsRows } from '@/lib/wall/host-vitals'
import { hostVitalsReport } from '@/lib/wall/stat-reports'
import { useWallCursor } from '@/lib/wall/use-wall-cursor'
import { useWallReportView } from '@/lib/wall/use-wall-report-view'
import { WallHistoryGap } from '../wall-history-gap'
import { WallPane } from '../wall-pane'
import { HostVitalsRowView } from './host-vitals-row'
import { useVitalsClock } from './use-vitals-clock'

const AXES: readonly WallAxis[] = ['text', 'host']

export default function HostVitalsPane() {
  const { hosts, historyLostAt } = useWallChannel()
  const now = useVitalsClock()
  const { offsetMs, rewound } = useWallCursor()

  // `now` is in here so a row crosses into stale on the clock, not on the next
  // frame -- which by definition is not coming for the node that went quiet.
  const rows = useMemo(() => hostVitalsAtCursor(hostVitalsRows(hosts, now), offsetMs, now), [hosts, now, offsetMs])

  const { rows: shown, matched, total } = useWallFilter(rows, AXES, r => ({ title: r.alias, host: r.alias }))
  const view = useWallReportView()

  return (
    <WallPane
      title="HOST VITALS"
      code="S1"
      count={`${matched}/${total}`}
      rewind="series"
      report={() => hostVitalsReport(shown, view)}
    >
      {shown.length === 0 ? (
        <p className="text-meta text-fg-faint px-0.5 py-1">
          {/* Three different silences, three different sentences. Rewound past
              every ring is NOT "no node reporting" -- the fleet was fine, this
              pane's five-minute history just does not reach that far back. */}
          {total === 0 && rewound
            ? 'no history at this offset'
            : total === 0
              ? 'no node reporting'
              : 'no node matches the filter'}
        </p>
      ) : (
        shown.map(row => <HostVitalsRowView key={row.nodeId} row={row} />)
      )}
      {/* The sparklines are accumulated from frames, so a reconnect leaves every
          one of them short. A flat trace and a flat machine draw the same. */}
      <WallHistoryGap at={historyLostAt} />
    </WallPane>
  )
}
