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
 */

import { useMemo } from 'react'
import { useWallChannel } from '@/hooks/use-wall-channel'
// Through the barrel: `filter.ts` is the surface every pane imports, so the
// substrate can move a file without eleven panes noticing.
import { useWallFilter, type WallAxis } from '@/lib/wall/filter'
import { hostVitalsRows } from '@/lib/wall/host-vitals'
import { WallPane } from '../wall-pane'
import { HostVitalsRowView } from './host-vitals-row'
import { useVitalsClock } from './use-vitals-clock'

const AXES: readonly WallAxis[] = ['text', 'host']

// fallow-ignore-next-line unused-export -- mounted through the registry's dynamic import()
export default function HostVitalsPane() {
  const { hosts } = useWallChannel()
  const now = useVitalsClock()

  // `now` is in here so a row crosses into stale on the clock, not on the next
  // frame -- which by definition is not coming for the node that went quiet.
  const rows = useMemo(() => hostVitalsRows(hosts, now), [hosts, now])

  const { rows: shown, matched, total } = useWallFilter(rows, AXES, r => ({ title: r.alias, host: r.alias }))

  return (
    <WallPane title="HOST VITALS" code="S1" count={`${matched}/${total}`}>
      {shown.length === 0 ? (
        <p className="text-meta text-fg-faint px-0.5 py-1">
          {total === 0 ? 'no node reporting' : 'no node matches the filter'}
        </p>
      ) : (
        shown.map(row => <HostVitalsRowView key={row.nodeId} row={row} />)
      )}
    </WallPane>
  )
}
