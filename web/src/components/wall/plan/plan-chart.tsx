/**
 * The S2 chart: one line per profile over the last five hours, with the 80%
 * throttle line dashed across it.
 *
 * The throttle line is drawn ON TOP of the series, not under it, and in the
 * destructive token rather than a chart hue -- at a glance it has to read as a
 * limit being crossed, not as a sixth profile.
 */

import { WALL_PLAN_THROTTLE_PCT, WALL_PLAN_WINDOW_MS } from '@shared/wall-plan-series'
import { PLAN_VIEWBOX, type PlanDomain, type PlanLine, planPath, planRuleY } from './plan-model'

interface PlanChartProps {
  lines: readonly PlanLine[]
  /** Right edge of the window. Passed in so the whole pane shares one clock. */
  now: number
}

export function PlanChart({ lines, now }: PlanChartProps) {
  const domain: PlanDomain = { from: now - WALL_PLAN_WINDOW_MS, to: now }
  const throttleY = planRuleY(WALL_PLAN_THROTTLE_PCT)

  return (
    <svg
      className="wall-plan-chart"
      viewBox={`0 0 ${PLAN_VIEWBOX.width} ${PLAN_VIEWBOX.height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Plan utilization over the last 5 hours, ${lines.length} profile(s), throttle line at ${WALL_PLAN_THROTTLE_PCT}%`}
    >
      <title>{`5h plan utilization -- throttle line at ${WALL_PLAN_THROTTLE_PCT}%`}</title>

      {[25, 50, 75].map(pct => (
        <line
          key={pct}
          className="wall-plan-grid"
          x1={0}
          x2={PLAN_VIEWBOX.width}
          y1={planRuleY(pct)}
          y2={planRuleY(pct)}
          vectorEffect="non-scaling-stroke"
        />
      ))}

      {lines.map(line => (
        <path
          key={line.key}
          className="wall-plan-line"
          d={planPath(line.segments, domain)}
          stroke={line.color}
          vectorEffect="non-scaling-stroke"
          data-profile={line.key}
        />
      ))}

      <line
        className="wall-plan-throttle"
        data-testid="wall-plan-throttle"
        x1={0}
        x2={PLAN_VIEWBOX.width}
        y1={throttleY}
        y2={throttleY}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
