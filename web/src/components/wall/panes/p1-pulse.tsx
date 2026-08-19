/**
 * P1 PULSE -- the fleet grouped by activity band, with a TIDE alternative.
 * Feed: web/src/hooks/use-pulse-fleet.ts.
 *
 * STUB. Card `wall-pane-pulse` rewrites THIS FILE and no other: the grid
 * imports it by path once (wall-pane-registry.ts) and never changes again.
 * Keep the default export, the code and the sizing props; everything else here
 * is yours. BANDS/TIDE goes in WallPane's `tabs` slot, the row count in `count`.
 */

import { WallPane } from '../wall-pane'
import { WallPaneEmpty } from '../wall-pane-empty'

// fallow-ignore-next-line unused-export -- mounted through the registry's dynamic import()
export default function PulsePane() {
  return (
    <WallPane title="PULSE" code="P1" grow>
      <WallPaneEmpty />
    </WallPane>
  )
}
