import { useCallback, useRef, useState } from 'react'
import {
  type ConversationHit,
  parseConversationHits,
  parseSnippetHits,
  type SearchResponse,
  type SnippetHit,
  type SortMode,
} from './types'

/** The FTS5 request itself: fetching, results, loading, sort order.
 *
 *  Separated from the dialog's navigation state (query text, drill-in) so that
 *  neither half has to be read to understand the other. */
export function useSearchRequest() {
  const [conversationHits, setConversationHits] = useState<ConversationHit[]>([])
  const [snippetHits, setSnippetHits] = useState<SnippetHit[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [sort, setSort] = useState<SortMode>('relevance')

  // Mirrored so debounced callers read the current order without re-plumbing
  // every call site or busting memo deps.
  const sortRef = useRef(sort)
  sortRef.current = sort

  const clear = useCallback(() => {
    setConversationHits([])
    setSnippetHits([])
    setTotal(0)
  }, [])

  const search = useCallback(
    async (q: string, conversationId?: string) => {
      if (!q.trim()) {
        clear()
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const params = new URLSearchParams({ q: q.trim(), limit: '50' })
        if (conversationId) params.set('conversation', conversationId)
        if (sortRef.current === 'recency') params.set('sort', 'recency')
        const res = await fetch(`/api/search?${params}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as SearchResponse
        setTotal(data.total)
        if (conversationId) setSnippetHits(parseSnippetHits(data))
        else setConversationHits(parseConversationHits(data))
      } catch {
        clear()
      } finally {
        setLoading(false)
      }
    },
    [clear],
  )

  const resetSort = useCallback(() => {
    setSort('relevance')
    sortRef.current = 'relevance'
  }, [])

  const applySort = useCallback((next: SortMode) => {
    setSort(next)
    sortRef.current = next
  }, [])

  return { conversationHits, snippetHits, loading, total, sort, search, clear, applySort, resetSort }
}
