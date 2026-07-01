// Expansion state for THE CANVAS + the transcript lifecycle behind it.
// Expanding a card fetches its transcript into the store cache; a non-empty
// cache entry makes the WS subscription manager auto-subscribe that
// conversation (see use-websocket.ts desired-set diff), so live entries
// stream in. Collapsing empties the cache entry, which unsubscribes -- except
// for the dashboard-selected conversation, whose cache the dashboard owns.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { fetchTranscript, useConversationsStore } from '@/hooks/use-conversations'

export interface CanvasActions {
  toggleExpand: (id: string) => void
}

export const CanvasActionsContext = createContext<CanvasActions>({ toggleExpand: () => {} })

export function useCanvasActions(): CanvasActions {
  return useContext(CanvasActionsContext)
}

// react-doctor-disable react-doctor/no-derived-state -- standalone imperative functions, not hooks
async function primeTranscript(id: string): Promise<void> {
  const store = useConversationsStore.getState()
  if (store.transcripts[id]?.length) return // already cached (and subscribed)
  const result = await fetchTranscript(id)
  if (result) useConversationsStore.getState().setTranscript(id, result.entries)
}

function releaseTranscript(id: string): void {
  const store = useConversationsStore.getState()
  if (store.selectedConversationId === id) return // dashboard owns this cache
  if (store.transcripts[id]) store.setTranscript(id, [])
}

export function useExpanded(): { expandedIds: ReadonlySet<string>; toggleExpand: (id: string) => void } {
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  const expandedRef = useRef(expandedIds)
  expandedRef.current = expandedIds

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        releaseTranscript(id)
      } else {
        next.add(id)
        void primeTranscript(id)
      }
      return next
    })
  }, [])

  // Refetch any expanded card whose cache got evicted (e.g. a WS reconnect
  // wipes non-selected transcripts) so cards never sit empty.
  useEffect(() => {
    const unsub = useConversationsStore.subscribe(state => {
      for (const id of expandedRef.current) {
        if (!state.transcripts[id]) void primeTranscript(id)
      }
    })
    return unsub
  }, [])

  // Leaving the canvas releases every expanded transcript subscription.
  useEffect(() => {
    return () => {
      for (const id of expandedRef.current) releaseTranscript(id)
    }
  }, [])

  return { expandedIds, toggleExpand }
}
