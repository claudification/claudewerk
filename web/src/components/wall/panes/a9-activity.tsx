/**
 * A9 ACTIVITY MATRIX -- a year of days, and the intensity metric is a SWITCH.
 *
 * The question is "how much of my days did we fill with beneficial work", and
 * the twist that makes it worth building is that the same geometry answers it
 * five different ways. A week that looks productive coloured by COMMITS and
 * expensive coloured by USD is telling you something neither axis says alone.
 * That contrast IS the feature.
 *
 * THE DEFAULT IS `commits`, AND THAT IS A JUDGEMENT, NOT A COINCIDENCE. Turns
 * and tokens go UP when an agent thrashes, so the day with the most tokens in
 * this project's history may well be a loop. Defaulting the grid to a volume
 * metric would paint that loop as the best day of the year. The default is the
 * one OUTPUT metric that can also fill the grid, and the volume metrics sit
 * beside it in the switch rather than instead of it.
 *
 * THE SWITCH IS IN THE BODY, NOT IN THE HEAD's `tabs` SLOT. Five labels do not
 * fit beside a title, a code, a count and a copy button in a 300px column, and a
 * switch that truncated would hide the metrics the honesty rule exists to keep
 * visible. It is still `WallTab`, so it reads as the same control the rest of
 * the wall uses.
 *
 * IT DECLARES `text` AND NOTHING ELSE, and both halves are deliberate. The
 * server's fold is FLEET-WIDE -- there is no per-project, per-host or per-model
 * cut of it -- so a pane that narrowed on `@anvil` would be showing the whole
 * fleet under a label saying otherwise. What its rows DO carry is a date, so
 * free text over the day string is a facet it genuinely has: `2026-08` narrows
 * the grid to August, and a query that matches nothing empties it honestly
 * rather than leaving one pane full while the rest of the wall goes quiet.
 *
 * It PUBLISHES the `time` axis (a click scopes the wall to that day) without
 * CONSUMING it, which is also what makes it BLIND at a rewound cursor: a
 * three-hour scrub cannot be subtracted from a day bucket, so there is nothing
 * true it could show at an offset.
 *
 * NOT IN SCOPE, on the card's own instruction: streaks, badges, anything that
 * turns the grid into a score. The moment it rewards keeping the squares green
 * it starts producing turns for their own sake, which is the failure it was
 * built to measure.
 */

import { ACTIVITY_DEFAULT_METRIC, ACTIVITY_METRIC_META, type ActivityMetricId } from '@shared/activity-matrix'
import { useMemo, useState } from 'react'
import { useActivityFeed, viewerTimeZone } from '@/hooks/use-activity-feed'
import { type ActivitySquare, activityMonthLabels, activityWeeks } from '@/lib/wall/activity-grid'
import { activityReport } from '@/lib/wall/activity-report'
import {
  activityDayFacts,
  activitySeries,
  formatActivityCount,
  formatActivityDay,
  formatHorizon,
} from '@/lib/wall/activity-values'
import { selectWallDay, useWallFilter, useWallFilterStore, type WallAxis } from '@/lib/wall/filter'
import { useWallReportView } from '@/lib/wall/use-wall-report-view'
import { ActivityDayCard } from '../activity/activity-day-card'
import { ActivityLegend } from '../activity/activity-legend'
import { ActivitySquares } from '../activity/activity-squares'
import { WallPane } from '../wall-pane'
import { WallPaneEmpty } from '../wall-pane-empty'
import { WallTab } from '../wall-tab'

/** The one facet a day genuinely has. See the header for why it is the only one. */
const AXES: readonly WallAxis[] = ['text']

export default function ActivityPane() {
  const { matrix, settled, stale } = useActivityFeed()
  const [metric, setMetric] = useState<ActivityMetricId>(ACTIVITY_DEFAULT_METRIC)
  const [hovered, setHovered] = useState<number | null>(null)
  const scopedDay = useWallFilterStore(selectWallDay)

  const series = activitySeries(matrix, metric)
  const days = matrix?.days ?? []

  // Each day carries WHERE IT SITS on the server's axis, because filtering the
  // days must not move the cells: every metric's array is indexed against the
  // full axis and stays that way.
  const entries = useMemo(() => days.map((day, index) => ({ ...day, index })), [days])
  const axis = useWallFilter(entries, AXES, entry => ({ title: entry.day }))

  const grid = useMemo(() => {
    const weeks = activityWeeks(axis.rows, series)
    return { weeks, months: activityMonthLabels(weeks) }
  }, [axis.rows, series])

  const reading = (square: ActivitySquare): string => {
    const day = formatActivityDay(square.day.day, square.day.dow)
    if (square.cell.state === 'unavailable') return `${day}: no data for ${series?.label ?? metric}`
    if (square.cell.state === 'empty') return `${day}: no ${series?.label ?? metric}`
    return `${day}: ${formatActivityCount(square.cell.value ?? 0, series?.unit ?? 'count')} ${series?.label ?? metric}`
  }

  const view = useWallReportView()
  const hoveredDay = hovered !== null ? days[hovered] : undefined

  return (
    <WallPane
      title="ACTIVITY"
      code="A9"
      count={`${axis.matched}/${axis.total} days`}
      stale={stale}
      report={() => activityReport(matrix, view)}
    >
      {matrix === null ? (
        // Two different silences, and the pane must not merge them either: a feed
        // that has not answered yet is not a broker that refused. `settled` with
        // nothing in hand is the 403 an ordinary viewer gets on an admin route.
        settled ? (
          <p className="wall-activity-idle">no activity feed -- this grid is admin-only</p>
        ) : (
          <WallPaneEmpty />
        )
      ) : (
        <div className="wall-activity">
          <div className="wall-activity-switch">
            {ACTIVITY_METRIC_META.map(meta => (
              <WallTab
                key={meta.id}
                label={meta.label}
                active={meta.id === metric}
                onPick={() => setMetric(meta.id)}
                title={formatHorizon(activitySeries(matrix, meta.id)?.horizon ?? { kind: 'unbounded', note: '' })}
              />
            ))}
          </div>
          {grid.weeks.length === 0 ? (
            // The filter took every square. Said out loud, because an empty grid
            // and a year of empty grid look identical from across a room.
            <p className="wall-activity-idle">no day matches the filter</p>
          ) : (
            <ActivitySquares
              weeks={grid.weeks}
              months={grid.months}
              scopedDay={scopedDay}
              reading={reading}
              onHover={setHovered}
              onPick={day => useWallFilterStore.getState().toggleDay(day)}
            />
          )}
          <ActivityLegend
            horizon={series ? formatHorizon(series.horizon) : 'this metric was not returned'}
            coverage={series ? `${series.activeDays}/${days.length} days active in ${matrix.tz}` : viewerTimeZone()}
          />
          <ActivityDayCard
            title={hoveredDay ? formatActivityDay(hoveredDay.day, hoveredDay.dow) : null}
            facts={hovered !== null ? activityDayFacts(matrix, hovered) : []}
            selected={metric}
            idle="hover a square for every metric at once · click one to scope the wall to that day"
          />
        </div>
      )}
    </WallPane>
  )
}
