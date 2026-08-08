import { useCallback, useState } from 'react'
import type { SortMode, ViewMode } from './types'
import { useDebounced } from './use-debounced'
import { useSearchRequest } from './use-search-request'

/** The indexed FTS5 search: debounced, runs on every keystroke, milliseconds.
 *
 *  This half owns where the user IS (query text, conversations vs snippets,
 *  which conversation is drilled into); useSearchRequest owns the fetch. */
export function useHotSearch() {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<ViewMode>('conversations')
  const [focusedConversation, setFocusedConversation] = useState<string | null>(null)
  const req = useSearchRequest()
  const debounce = useDebounced(150)

  const reset = useCallback(() => {
    setQuery('')
    setMode('conversations')
    setFocusedConversation(null)
    req.clear()
    req.resetSort()
  }, [req])

  const changeQuery = useCallback(
    (value: string) => {
      setQuery(value)
      debounce(() => {
        if (mode === 'snippets' && focusedConversation) {
          req.search(value, focusedConversation)
          return
        }
        setMode('conversations')
        setFocusedConversation(null)
        req.search(value)
      })
    },
    [debounce, req, mode, focusedConversation],
  )

  const drillInto = useCallback(
    (conversationId: string) => {
      setMode('snippets')
      setFocusedConversation(conversationId)
      req.search(query, conversationId)
    },
    [req, query],
  )

  const drillOut = useCallback(() => {
    setMode('conversations')
    setFocusedConversation(null)
    req.search(query)
  }, [req, query])

  const changeSort = useCallback(
    (next: SortMode) => {
      if (next === req.sort) return
      req.applySort(next)
      if (query.trim()) req.search(query, mode === 'snippets' ? (focusedConversation ?? undefined) : undefined)
    },
    [req, query, mode, focusedConversation],
  )

  return {
    query,
    mode,
    focusedConversation,
    conversationHits: req.conversationHits,
    snippetHits: req.snippetHits,
    loading: req.loading,
    total: req.total,
    sort: req.sort,
    changeQuery,
    drillInto,
    drillOut,
    changeSort,
    reset,
  }
}
