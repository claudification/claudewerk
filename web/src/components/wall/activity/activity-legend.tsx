/**
 * THE LEGEND -- and it is the pane's disclaimer, not its decoration.
 *
 * A contribution grid makes any number look authoritative. Three things have to
 * be readable without hovering anything, or the grid is a lie by omission:
 *
 *  1. the ramp, LESS -> MORE, so a shade means a magnitude;
 *  2. the two silences, side by side and labelled, so the reader can see that
 *     `no data` and `none` are different squares before they draw a conclusion
 *     from a grey run;
 *  3. WHAT THIS METRIC CANNOT SEE. Three of the five prune at 30 days, so
 *     eleven twelfths of their grid is unavailable, and the horizon line is what
 *     stops that reading as a year off.
 */

import { ACTIVITY_LEVELS } from '@/lib/wall/activity-grid'

interface ActivityLegendProps {
  /** `formatHorizon(series.horizon)` -- how far back the coloured metric sees. */
  horizon: string
  /** `14 of 366 days · 903 commits`, the metric's own totals. */
  coverage: string
}

export function ActivityLegend({ horizon, coverage }: ActivityLegendProps) {
  return (
    <div className="wall-activity-legend">
      <div className="wall-activity-legend-row">
        <span className="wall-activity-legend-label">LESS</span>
        {Array.from({ length: ACTIVITY_LEVELS }, (_, i) => (
          <span className={`wall-activity-cell is-active lvl-${i + 1}`} key={`lvl-${i + 1}`} />
        ))}
        <span className="wall-activity-legend-label">MORE</span>
        <span className="flex-1" />
        {/* The two silences, told apart on screen rather than in a tooltip. */}
        <span className="wall-activity-cell is-empty" />
        <span className="wall-activity-legend-label">NONE</span>
        <span className="wall-activity-cell is-unavailable" />
        <span className="wall-activity-legend-label">NO DATA</span>
      </div>
      <p className="wall-activity-horizon">
        {coverage} · {horizon}
      </p>
    </div>
  )
}
