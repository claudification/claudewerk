import { useState } from 'react'
import { requestTranscriptJump } from '@/components/transcript/transcript-jump-store'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useCommand } from '@/lib/commands'
import { useColdSearch } from './use-cold-search'
import { useFocusOnOpen } from './use-debounced'
import { useHotSearch } from './use-hot-search'
import { useSearchKeys } from './use-search-keys'

/** Both bindings open the same dialog; Cmd+Shift+F exists because some browsers
 *  swallow Cmd+F. */
function useOpenCommands(openSearch: () => void): void {
  const opts = { label: 'Search transcripts', group: 'Navigation' }
  useCommand('search-transcripts', openSearch, { ...opts, shortcut: 'mod+f' })
  useCommand('search-transcripts-alt', openSearch, { ...opts, shortcut: 'mod+shift+f' })
}

/** Falls back to a short id so a drilled-in conversation always has a label,
 *  even before its title has arrived. */
function titleFor(conversationId: string | null, hits: Array<{ conversationId: string; title: string }>): string {
  if (!conversationId) return ''
  return hits.find(h => h.conversationId === conversationId)?.title ?? conversationId.slice(0, 8)
}

/** Everything the dialog DOES, so the component is only what it LOOKS like.
 *
 *  It also owns the one rule that spans both searches: the hot list and the cold
 *  list share a single active index, and a cold result belongs to the query that
 *  produced it and to nothing else. */
export function useSearchDialog() {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const hot = useHotSearch()
  const cold = useColdSearch(open)
  const inputRef = useFocusOnOpen(open)

  function openSearch() {
    setOpen(true)
    setActiveIndex(0)
    hot.reset()
    cold.clear()
  }

  useOpenCommands(openSearch)

  /** Open the conversation AND land on the matched message. The seq is queued
   *  before the selection so the transcript sees the request on its very first
   *  render for that conversation -- queue it after and the view has already
   *  settled at the bottom, which then reads as a scroll rather than a jump. */
  function goTo(conversationId: string, seq?: number) {
    if (seq !== undefined) requestTranscriptJump(conversationId, seq)
    useConversationsStore.getState().selectConversation(conversationId, 'transcript-search')
    setOpen(false)
  }

  function changeQuery(value: string) {
    setActiveIndex(0)
    cold.clear()
    hot.changeQuery(value)
  }

  const inSnippetMode = hot.mode === 'snippets'
  const coldHits = cold.result?.hits ?? []

  const handleKeyDown = useSearchKeys({
    hotHits: inSnippetMode ? hot.snippetHits : hot.conversationHits,
    coldHits,
    drillableHits: inSnippetMode ? [] : hot.conversationHits,
    activeIndex,
    setActiveIndex,
    inSnippetMode,
    query: hot.query,
    goTo,
    drillInto: hot.drillInto,
    drillOut: hot.drillOut,
    close: () => setOpen(false),
  })

  const focusedTitle = titleFor(hot.focusedConversation, hot.conversationHits)

  return {
    open,
    setOpen,
    activeIndex,
    setActiveIndex,
    hot,
    cold,
    coldHits,
    inputRef,
    handleKeyDown,
    focusedTitle,
    goTo,
    changeQuery,
  }
}
