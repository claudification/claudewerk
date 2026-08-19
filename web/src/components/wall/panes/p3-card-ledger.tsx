/**
 * P3 CARD LEDGER -- board cards changing lane, epics excluded.
 * Feed: the new card-change events (card `board-card-change-events`).
 *
 * STUB. Card `wall-pane-card-ledger` rewrites THIS FILE and no other.
 * ALL/DONE goes in WallPane's `tabs` slot.
 */

import { WallPane } from '../wall-pane'
import { WallPaneEmpty } from '../wall-pane-empty'

// fallow-ignore-next-line unused-export -- mounted through the registry's dynamic import()
export default function CardLedgerPane() {
  return (
    <WallPane title="CARD LEDGER" code="P3" maxHeight="32%">
      <WallPaneEmpty />
    </WallPane>
  )
}
