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
 * the query before a row is looked at: typing `%70` leaves this pane full.
 *
 * THE TIME CURSOR IS ANSWERED HERE, not by `useWallFilter`. This pane has no
 * per-row age -- a plan LINE is a whole series, and rewinding it means cutting
 * the series at the cursor rather than dropping rows. So the samples are cut
 * BEFORE `buildPlanLines`, which gets the segments, the `latest` row and the
 * worst-first ordering right for free: at `T-42m` the pane answers "which
 * account was closest to the limit then", with the chart's right edge at then.
 * An account with no sample that old simply is not there, and if none of them
 * have one the pane says so instead of drawing five live hours under a rewound
 * header.
 */

import { useMemo } from 'react'
import { useWallChannel } from '@/hooks/use-wall-channel'
import { useWallCursor } from '@/lib/wall/use-wall-cursor'
import { useWallFilter } from '@/lib/wall/use-wall-filter'
import { PlanChart } from '../plan/plan-chart'
import { buildPlanLines } from '../plan/plan-model'
import { PlanRows } from '../plan/plan-rows'
import { WallHistoryGap } from '../wall-history-gap'
import { WallPane } from '../wall-pane'
import { WallPaneEmpty } from '../wall-pane-empty'

const AXES = ['text', 'host'] as const

export default function PlanUsagePane() {
  const { plan, at, historyLostAt } = useWallChannel()
  const { offsetMs, rewound } = useWallCursor()

  // The frame clock, not this component's: the chart's right edge is "when the
  // broker last spoke", so a dead socket stops the window moving instead of
  // sliding the last real sample off the left of a chart that looks live. The
  // cursor moves that edge back, and nothing else about the window changes.
  const now = (at || Date.now()) - offsetMs

  const lines = useMemo(() => buildPlanLines(rewound ? plan.filter(s => s.at <= now) : plan), [plan, rewound, now])
  const { rows, matched, total } = useWallFilter(lines, AXES, line => ({
    title: line.profile,
    ...(line.node ? { host: line.node } : {}),
  }))

  return (
    <WallPane title="PLAN USAGE" code="S2" count={`${matched}/${total} · 5h`} maxHeight="30%" rewind="series">
      {/* Three silences, three sentences. `total` is the line count AFTER the
          cursor cut and BEFORE the filter, which is what separates them:
          `total === 0` while rewound means the pane HAS a history and simply
          does not reach that far back, `total === 0` live means the feed never
          came, and `total > 0` with nothing shown means the query took them.
          Only the middle one is the stub's -- printing "no feed yet" for the
          third would contradict the `0/2` in this pane's own header. */}
      {total === 0 && rewound ? <p className="text-meta text-fg-faint px-0.5 py-1">no history at this offset</p> : null}
      {total === 0 && !rewound ? <WallPaneEmpty /> : null}
      {total > 0 && rows.length === 0 ? (
        <p className="text-meta text-fg-faint px-0.5 py-1">no profile matches the filter</p>
      ) : null}
      {rows.length > 0 && (
        <div className="wall-plan">
          <PlanChart lines={rows} now={now} />
          <PlanRows lines={rows} />
        </div>
      )}
      {/* Under the chart AND under the empty line, because after a broker restart
          the empty case is the misleading one: a 5h window with nothing in it
          reads as five quiet hours rather than as five hours we no longer have. */}
      <WallHistoryGap at={historyLostAt} />
    </WallPane>
  )
}
