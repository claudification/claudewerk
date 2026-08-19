// fallow-ignore-file unused-file
//   No consumer yet BY DESIGN: the pane that reads this hook is
//   `wall-pane-card-ledger` (WALL P3), still open in `epic-the-wall`. The feed
//   half landed first so the ring + socket could be proven on their own.
//   DELETE THIS LINE when P3 lands -- a stale suppression is the next lie.
/**
 * `useCardLedger()` -- the card ledger as React state.
 *
 * Thin on purpose: `card-ledger-feed.ts` owns the ordering and the bound, and
 * the feed is filled from the `wall` channel's frames. This is the
 * `useSyncExternalStore` binding and nothing else -- there is no seed request
 * here, because the wall's `full` frame IS the seed.
 *
 * Requires the wall subscription to be held (`useWallChannel()`), which the
 * surface hosting the P3 pane does. A pane rendered outside the wall shows
 * whatever last arrived rather than opening a second feed of its own.
 */

import type { CardMove } from '@shared/protocol'
import { useSyncExternalStore } from 'react'
import { getCardLedger, subscribeCardLedger } from './card-ledger-feed'

/** Recent card lane moves, newest first. */
export function useCardLedger(): CardMove[] {
  return useSyncExternalStore(subscribeCardLedger, getCardLedger, getCardLedger)
}
