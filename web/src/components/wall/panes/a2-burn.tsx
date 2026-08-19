/**
 * A2 BURN -- the burn clock. What the fleet is costing you right now.
 * Feed: cost-utils + analytics.
 *
 * STUB. Card `wall-pane-fleet-burn` rewrites THIS FILE and p4-fleet.tsx.
 */

import { WallPane } from '../wall-pane'
import { WallPaneEmpty } from '../wall-pane-empty'

// fallow-ignore-next-line unused-export -- mounted through the registry's dynamic import()
export default function BurnPane() {
  return (
    <WallPane title="BURN" code="A2" count="last 60m">
      <WallPaneEmpty />
    </WallPane>
  )
}
