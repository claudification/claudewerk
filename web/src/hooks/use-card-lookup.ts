/**
 * Subscribe to one card through the provider seam.
 *
 * Deliberately NOT `useSyncExternalStore`: `peekCard` builds a fresh summary
 * object on every call, and a getSnapshot that never returns a stable reference
 * is the classic infinite-render trap. State + an equality gate keeps the
 * identity stable, so a card whose lane did not change never re-renders a panel.
 */

import { useEffect, useState } from 'react'
import {
  type CardLookup,
  type CardRef,
  cardRefKey,
  peekCard,
  resolveCard,
  resolveCardDeep,
  subscribeCards,
} from '@/lib/cards'

const UNAVAILABLE: CardLookup = { status: 'unavailable' }

/** Value identity of a lookup. A provider builds its summary the same way every
 *  time, so serializing is both cheaper to read and cheaper to maintain than a
 *  field-by-field comparison that silently rots when a field is added. */
function signature(lookup: CardLookup): string {
  return lookup.status === 'ready' ? JSON.stringify(lookup.summary) : lookup.status
}

/** `deep` pulls what an epic rollup needs -- pass it only for hover surfaces. */
export function useCardLookup(ref: CardRef | null, deep = false): CardLookup {
  const [lookup, setLookup] = useState<CardLookup>(() => (ref ? peekCard(ref) : UNAVAILABLE))

  const key = ref ? cardRefKey(ref) : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the identity of ref
  useEffect(() => {
    if (!ref) {
      setLookup(UNAVAILABLE)
      return
    }
    const read = () => {
      const next = peekCard(ref)
      setLookup(prev => (signature(prev) === signature(next) ? prev : next))
    }
    read()
    resolveCard(ref)
    if (deep) resolveCardDeep(ref)
    return subscribeCards(read)
  }, [key, deep])

  return lookup
}
