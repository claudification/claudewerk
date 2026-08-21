/**
 * A5 NOW -- one stacked line across the top saying what the fleet is doing this
 * second. Feed: `conversation.classified` (`Conversation.turnSummary`), folded by
 * `now-bar-fold.ts` -- read that file for why the classes are what they are.
 *
 * NOT A <WallPane>, and the mockup is why: A5 is a strip between the header and
 * the grid with no pane header and no border (`.nowbar` in the approved mockup).
 * So the reference code and the count ride in the strip instead of in a pane
 * head. It is also the ONE surface the mockup deliberately does not give
 * `hideamb` -- when ambient mode strips the chrome, this line is what is left to
 * read from across a room, so it scales UP instead of disappearing.
 *
 * `managed` IS DELIBERATELY NOT DECLARED as an axis, and the feed is asked for
 * `+over`. The grammar hides machine-dispatched rows by default; an undeclared
 * axis is cleared to "hide nothing". A bar that answers "what is the fleet doing
 * right now" while silently omitting every epic seat and every nightshift worker
 * would be a lie in one glance, which is the only kind of glance this surface
 * gets. Same reasoning A1 already carries.
 */

import { useMemo } from 'react'
import { usePulseFleet } from '@/components/pulse/use-pulse-fleet'
import { cn } from '@/lib/utils'
import type { WallAxis } from '@/lib/wall/axes'
import { useWallFilter } from '@/lib/wall/use-wall-filter'
import { type NowSegment, nowSegments } from '../now-bar-fold'
import { useStripMetrics } from '../use-strip-metrics'

/** Ask the feed for the WHOLE fleet -- the wall's query is applied once, below. */
const WHOLE_FLEET = '+over'

/** Every axis a conversation carries, minus `managed` -- see the file header. */
const AXES: readonly WallAxis[] = [
  'text',
  'band',
  'project',
  'workspace',
  'tag',
  'time',
  'cost',
  'context',
  'host',
  'model',
]

function Segment({ seg }: { seg: NowSegment }) {
  return (
    <div
      className={cn('wall-nowseg', seg.fill)}
      // Proportional by construction: grow by the count, basis 0, so the widths
      // are the counts and can never drift from them.
      style={{ flexGrow: seg.n, flexBasis: 0 }}
      // The full reading is ALWAYS here, so a segment that degraded to its count
      // still says what it is on hover.
      title={seg.text}
      data-now={seg.cls}
    >
      {seg.fits ? seg.text : seg.n}
    </div>
  )
}

export default function NowBar() {
  const base = usePulseFleet(WHOLE_FLEET)
  const { rows, matched, total } = useWallFilter(base.flat, AXES)
  const [stackRef, metrics] = useStripMetrics<HTMLDivElement>()
  const segments = useMemo(() => nowSegments(rows, metrics.width, metrics.charPx), [rows, metrics])

  return (
    <section className="wall-nowbar" data-pane="A5" aria-label="NOW">
      <span className="wall-nowbar-cap">NOW</span>
      <span className="wall-pane-code">A5</span>
      <div ref={stackRef} className="wall-nowstack" data-empty={segments.length === 0 || undefined}>
        {segments.length === 0 ? (
          <span className="wall-nowempty">{total === 0 ? 'no conversations' : 'nothing matches'}</span>
        ) : (
          segments.map(seg => <Segment key={seg.cls} seg={seg} />)
        )}
      </div>
      <div className="wall-nowlegend">
        {segments.map(seg => (
          <span key={seg.cls} title={seg.label}>
            <i className={seg.fill} />
            {seg.n}
          </span>
        ))}
        {/* The wall's count contract. A5 has no pane head to put it in, so it
            rides the mockup's `of N` slot. Unfiltered it reads N/N. */}
        <span className="wall-nowtotal tabular-nums" title="shown / whole fleet">
          {matched}/{total}
        </span>
      </div>
    </section>
  )
}
