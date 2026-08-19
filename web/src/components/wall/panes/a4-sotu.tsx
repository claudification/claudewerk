/**
 * A4 STATE OF THE UNION -- the prose brief. Feed: src/broker/desk/.
 *
 * HIDDEN IN AMBIENT, per the mockup: it is the one pane made of sentences, and
 * nobody reads sentences from across a room.
 *
 * STUB. Card `wall-pane-sheaf-sotu` rewrites THIS FILE and a6-sheaf.tsx.
 */

import { WallPane } from '../wall-pane'
import { WallPaneEmpty } from '../wall-pane-empty'

// fallow-ignore-next-line unused-export -- mounted through the registry's dynamic import()
export default function SotuPane() {
  return (
    <WallPane title="STATE OF THE UNION" code="A4" hideInAmbient>
      <WallPaneEmpty />
    </WallPane>
  )
}
