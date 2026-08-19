/**
 * S2 PLAN USAGE -- utilization per profile, GRAPHED. The live value already
 * exists; the persisted series is the new part.
 *
 * STUB. Card `wall-plan-usage-series` rewrites THIS FILE and no other.
 */

import { WallPane } from '../wall-pane'
import { WallPaneEmpty } from '../wall-pane-empty'

// fallow-ignore-next-line unused-export -- mounted through the registry's dynamic import()
export default function PlanUsagePane() {
  return (
    <WallPane title="PLAN USAGE" code="S2" count="5h window">
      <WallPaneEmpty />
    </WallPane>
  )
}
