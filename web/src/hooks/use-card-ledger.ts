/**
 * `useCardLedger()` -- the card ledger as React state.
 *
 * Thin on purpose: `card-ledger-feed.ts` owns the socket, the ring seed and the
 * ordering; this is the `useSyncExternalStore` binding and nothing else.
 */

import type { CardMove } from '@shared/protocol'
import { useEffect, useSyncExternalStore } from 'react'
import { getCardLedger, seedCardLedger, subscribeCardLedger } from './card-ledger-feed'

/**
 * Recent card lane moves, newest first. Seeds from the broker's ring on first
 * mount so a cold surface has history immediately, then follows live pushes.
 */
export function useCardLedger(limit?: number): CardMove[] {
  useEffect(() => {
    void seedCardLedger(limit)
  }, [limit])

  return useSyncExternalStore(subscribeCardLedger, getCardLedger, getCardLedger)
}
