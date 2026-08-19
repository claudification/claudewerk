/**
 * A1 BLOCKED ON YOU -- the questions you can answer without leaving the wall.
 * Feed: web/src/hooks/use-attention-flags.ts.
 *
 * STUB. Card `wall-pane-attention` rewrites THIS FILE and no other.
 */

import { WallPane } from '../wall-pane'
import { WallPaneEmpty } from '../wall-pane-empty'

// fallow-ignore-next-line unused-export -- mounted through the registry's dynamic import()
export default function AttentionPane() {
  return (
    <WallPane title="BLOCKED ON YOU" code="A1" maxHeight="34%">
      <WallPaneEmpty />
    </WallPane>
  )
}
