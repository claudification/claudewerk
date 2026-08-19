/**
 * A7 UNATTENDED RUNS -- epic runs working without you, with their batons.
 * Feed: the overseer activity store.
 *
 * STUB. Card `wall-pane-unattended-runs` rewrites THIS FILE and no other.
 */

import { WallPane } from '../wall-pane'
import { WallPaneEmpty } from '../wall-pane-empty'

// fallow-ignore-next-line unused-export -- mounted through the registry's dynamic import()
export default function UnattendedRunsPane() {
  return (
    <WallPane title="UNATTENDED RUNS" code="A7" maxHeight="38%">
      <WallPaneEmpty />
    </WallPane>
  )
}
