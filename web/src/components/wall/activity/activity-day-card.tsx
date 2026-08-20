/**
 * THE HOVERED DAY -- every metric at once, in a FIXED slot under the grid.
 *
 * Not a floating tooltip, and that is a deliberate call twice over. The wall is
 * read from across a room in ambient mode where nothing is hovering anything, so
 * a panel that only exists under a cursor would be blank exactly when the
 * surface is doing its job; and a tooltip over a 366-square grid spends its life
 * covering the squares either side of the one you are asking about.
 *
 * ALL FIVE METRICS, ALWAYS. The whole argument of this pane is that the same
 * week looks productive on one axis and wasteful on another -- so a day that
 * shipped two commits for eleven dollars says both, side by side, and the reader
 * draws their own conclusion. Showing only the coloured metric would let the
 * grid make the loudest case for whichever axis happened to be selected.
 */

import { cn } from '@/lib/utils'
import type { ActivityDayFact } from '@/lib/wall/activity-values'

interface ActivityDayCardProps {
  /** `Fri 14 Aug 2026`, or null when nothing is hovered. */
  title: string | null
  facts: readonly ActivityDayFact[]
  /** Which metric the grid is coloured by -- marked, so the reader can see which
   *  of the five numbers produced the shade they are looking at. */
  selected: string
  /** What the slot says with no day under the cursor. */
  idle: string
}

export function ActivityDayCard({ title, facts, selected, idle }: ActivityDayCardProps) {
  if (title === null) return <p className="wall-activity-idle">{idle}</p>
  return (
    <div className="wall-activity-day">
      <p className="wall-activity-day-title">{title}</p>
      <dl className="wall-activity-facts">
        {facts.map(fact => (
          <div
            key={fact.metric}
            className={cn('wall-activity-fact', fact.metric === selected && 'is-selected')}
            data-metric={fact.metric}
            data-state={fact.state}
          >
            <dt>{fact.label}</dt>
            <dd>
              {fact.text}
              {/* The provenance is never optional chrome on a dollar: an
                  estimated number rendered as a measured one is the single rule
                  this pane's card calls its whole design risk. */}
              {fact.provenance && <em className="wall-activity-provenance">{fact.provenance}</em>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
