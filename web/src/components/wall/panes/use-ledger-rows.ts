/**
 * P3's feed: the card ledger, live, as ledger rows.
 *
 * NO FETCH AND NO SECOND SUBSCRIPTION. `card-ledger-feed.ts` is a module-global
 * store that the wall frame handler already folds every frame into -- the
 * broker's ring arrives in the `full: true` snapshot on subscribe and live moves
 * arrive in the deltas after it. So this hook is a `useSyncExternalStore` read
 * and nothing else: a card moved on the board appears here without a refetch
 * because there was never a fetch to repeat.
 *
 * THE FEED IS TAKEN WHOLE. Filtering happens once, in the pane, through
 * `useWallFilter` -- a pre-filtered feed would fork the predicate and make the
 * wall's own query box disagree with `{matched}/{total}`.
 */

import { useMemo, useSyncExternalStore } from 'react'
import { getCardLedger, subscribeCardLedger } from '@/hooks/card-ledger-feed'
import { cardLedgerRows, type LedgerRow } from '@/lib/wall/card-ledger'
import { useProjectLook } from '../use-project-look'
import { useWallClock } from '../use-wall-clock'

/**
 * TEN SECONDS.
 *
 * Board moves are a human-paced event and the age column tops out in seconds
 * only for the first minute, so a per-second tick would rebuild and re-filter
 * the list sixty times a minute to move one digit. The clock exists at all
 * because `~30m` typed in the wall's box has to keep meaning thirty minutes as
 * the wall sits there -- an age frozen at mount would quietly stop dropping
 * rows. Ten seconds is close enough that a fresh move never looks stale and far
 * enough that the pane is not a metronome.
 */
const LEDGER_TICK_MS = 10_000

export function useLedgerRows(): LedgerRow[] {
  const moves = useSyncExternalStore(subscribeCardLedger, getCardLedger, getCardLedger)
  const look = useProjectLook()
  const nowMs = useWallClock(LEDGER_TICK_MS)

  return useMemo(() => cardLedgerRows(moves, look, nowMs), [moves, look, nowMs])
}
