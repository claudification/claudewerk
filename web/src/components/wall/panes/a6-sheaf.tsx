/**
 * A6 SHEAF -- the structural ledger: where the money and the conversation TREES
 * went. Feed: summarizeSheaf() in src/broker/desk/fleet-sheaf.ts.
 *
 * STUB. Card `wall-pane-sheaf-sotu` rewrites THIS FILE and a4-sotu.tsx -- one
 * route feeds both, which is why they are one card. 6h/24h/7d goes in WallPane's
 * `tabs` slot.
 */

import { WallPane } from '../wall-pane'
import { WallPaneEmpty } from '../wall-pane-empty'

// fallow-ignore-next-line unused-export -- mounted through the registry's dynamic import()
export default function SheafPane() {
  return (
    <WallPane title="SHEAF" code="A6">
      <WallPaneEmpty />
    </WallPane>
  )
}
