import { useCallback, useEffect, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { setConversationTab } from '@/lib/ui-state'
import type { Tab } from './conversation-tabs'

const KNOWN_TABS: ReadonlySet<string> = new Set([
  'transcript',
  'tty',
  'json_stream',
  'events',
  'agents',
  'tasks',
  'shared',
  'diag',
])

/** Coerce a requested/remembered tab to a real one. Legacy 'project' (now a
 *  modal launcher, not a tab) and any unknown value fall back to transcript. */
function sanitizeTab(tab: string): Tab {
  return (KNOWN_TABS.has(tab) ? tab : 'transcript') as Tab
}

export function useConversationTab(selectedConversationId: string | null) {
  const [activeTab, setActiveTab] = useState<Tab>('transcript')
  const [follow, setFollow] = useState(true)
  const [infoExpanded, setInfoExpanded] = useState(false)
  const [conversationTarget, setConversationTarget] = useState<{
    projectA: string
    projectB: string
    nameA: string
    nameB: string
  } | null>(null)
  const disableFollow = useCallback(() => setFollow(false), [])
  const enableFollow = useCallback(() => setFollow(true), [])

  const requestedTab = useConversationsStore(state => state.requestedTab)
  const requestedTabSeq = useConversationsStore(state => state.requestedTabSeq)

  // Reset follow + conversation target when switching conversations.
  const [prevConversationId, setPrevConversationId] = useState(selectedConversationId)
  if (selectedConversationId !== prevConversationId) {
    setPrevConversationId(selectedConversationId)
    setFollow(true)
    setConversationTarget(null)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: requestedTabSeq is a counter dep key
  useEffect(() => {
    if (requestedTab) setActiveTab(sanitizeTab(requestedTab))
  }, [requestedTab, requestedTabSeq])

  useEffect(() => {
    if (selectedConversationId) setConversationTab(selectedConversationId, activeTab)
  }, [selectedConversationId, activeTab])

  // Mirror the user's "reading-history" intent into the store so the transcript
  // prune sites (use-websocket-handlers.ts, use-websocket.ts) can refuse to
  // lop off the head while the user is scrolled away from the live tail.
  // follow=true  -> bottom-pinned     -> scrollback inactive (collapse over-cap)
  // follow=false -> scrolled away     -> scrollback active   (prune suppressed)
  useEffect(() => {
    if (!selectedConversationId) return
    useConversationsStore.getState().setScrollbackActive(selectedConversationId, !follow)
  }, [selectedConversationId, follow])

  return {
    activeTab,
    setActiveTab,
    follow,
    setFollow,
    disableFollow,
    enableFollow,
    infoExpanded,
    setInfoExpanded,
    conversationTarget,
    setConversationTarget,
  }
}
