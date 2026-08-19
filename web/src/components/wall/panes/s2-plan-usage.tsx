/**
 * S2 PLAN USAGE -- utilization per profile and host, GRAPHED over the 5h window.
 *
 * The live number already existed. What did not is the SHAPE: "am I about to get
 * throttled, and which account first" is a question about the last five hours.
 * The series comes off the wall channel (`plan`), produced by the broker from
 * the per-profile snapshot it already holds -- there is no fetch, no poll and no
 * second utilization path in this file.
 *
 * FILTER. The axes this pane understands are `text` (the profile name) and
 * `host` (`&studio`). Everything else in the grammar -- projects, cost, context
 * pressure, models -- is a per-conversation fact and a plan bucket is a per-
 * ACCOUNT one, so those axes are not declared and are therefore stripped from
 * the query before a row is looked at: typing `%>70` leaves this pane full.
 */

import { useMemo } from 'react'
import { useWallChannel } from '@/hooks/use-wall-channel'
import { useWallFilter } from '@/lib/wall/use-wall-filter'
import { PlanChart } from '../plan/plan-chart'
import { buildPlanLines } from '../plan/plan-model'
import { PlanRows } from '../plan/plan-rows'
import { WallPane } from '../wall-pane'
import { WallPaneEmpty } from '../wall-pane-empty'

const AXES = ['text', 'host'] as const

export default function PlanUsagePane() {
  const { plan, at } = useWallChannel()
  const lines = useMemo(() => buildPlanLines(plan), [plan])
  const { rows, matched, total } = useWallFilter(lines, AXES, line => ({
    title: line.profile,
    ...(line.node ? { host: line.node } : {}),
  }))

  // The frame clock, not this component's: the chart's right edge is "when the
  // broker last spoke", so a dead socket stops the window moving instead of
  // sliding the last real sample off the left of a chart that looks live.
  const now = at || Date.now()

  return (
    <WallPane title="PLAN USAGE" code="S2" count={`${matched}/${total} · 5h`} maxHeight="30%">
      {rows.length === 0 ? (
        <WallPaneEmpty />
      ) : (
        <div className="wall-plan">
          <PlanChart lines={rows} now={now} />
          <PlanRows lines={rows} />
        </div>
      )}
    </WallPane>
  )
}
