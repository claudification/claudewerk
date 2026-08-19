/**
 * A5 NOW -- CC's own per-turn classifier, aggregated into one stacked bar.
 * Feed: `conversation.classified`.
 *
 * The ONE stub that is not a <WallPane>, and the mockup is why: A5 is a strip
 * between the header and the grid, with no pane header and no border -- see
 * `.nowbar` in the approved mockup. The epic ranks the mockup first, so this
 * keeps the strip and carries its reference code in the strip instead.
 *
 * STUB. Card `wall-pane-pulse` rewrites THIS FILE and p1-pulse.tsx (one
 * classifier feeds both).
 */

import { WallPaneEmpty } from '../wall-pane-empty'

// fallow-ignore-next-line unused-export -- mounted through the registry's dynamic import()
export default function NowBar() {
  return (
    <section className="wall-nowbar" data-pane="A5" aria-label="NOW">
      <span className="wall-nowbar-cap">NOW</span>
      <span className="wall-pane-code">A5</span>
      <WallPaneEmpty />
    </section>
  )
}
