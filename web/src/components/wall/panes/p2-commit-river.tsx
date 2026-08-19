/**
 * P2 COMMIT RIVER -- every commit the fleet lands, newest first.
 * Feed: web/src/hooks/use-commit-subscription.ts + commits.db.
 *
 * STUB. Card `wall-pane-commit-river` rewrites THIS FILE and no other.
 */

import { WallPane } from '../wall-pane'
import { WallPaneEmpty } from '../wall-pane-empty'

// fallow-ignore-next-line unused-export -- mounted through the registry's dynamic import()
export default function CommitRiverPane() {
  return (
    <WallPane title="COMMIT RIVER" code="P2" grow>
      <WallPaneEmpty />
    </WallPane>
  )
}
