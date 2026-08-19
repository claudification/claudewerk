/**
 * Every store read ConversationDetail needs, in one place.
 *
 * Lifted out of conversation-detail.tsx, which had grown past the .tsx split bar
 * with ~45 lines of selectors before the first line of JSX. The selectors are
 * subtle enough to deserve their own file: the events/transcript pair reads the
 * active tab from a REF so a tab switch does not re-run every subscriber, and
 * the permissions selector needs useShallow or it returns a fresh object each
 * render (React #185).
 */

import { projectIdentityKey } from '@shared/project-uri'
import type { HookEvent } from '@shared/protocol'
import { useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { TranscriptEntry } from '@/lib/types'

const EMPTY_EVENTS: HookEvent[] = []
const EMPTY_TRANSCRIPT: TranscriptEntry[] = []

/** Tabs whose content is driven by the live event/transcript arrays. Any other
 *  tab gets the frozen empties so a Diag or Files tab does not re-render on
 *  every streamed entry. */
const STREAMING_TABS = new Set(['events', 'transcript', 'tty'])

function usePermissions(conversationId: string) {
  return useConversationsStore(
    useShallow(s => {
      const p = s.conversationPermissions[conversationId] || s.permissions
      return {
        canAdmin: p.canAdmin,
        canChat: p.canChat,
        canReadTerminal: p.canReadTerminal,
        canFiles: p.canFiles,
        canSpawn: p.canSpawn,
      }
    }),
  )
}

export function useDetailData(conversationId: string, activeTab: string) {
  const showThinking = useConversationsStore(s => s.controlPanelPrefs.showThinking)
  const showDiag = useConversationsStore(s => s.controlPanelPrefs.showDiag)
  const showTerminal = useConversationsStore(state => state.showTerminal)
  const terminalWrapperId = useConversationsStore(state => state.terminalWrapperId)
  const expandAll = useConversationsStore(state => state.expandAll)
  const conversation = useConversationsStore(state => state.conversationsById[conversationId])
  // An off-roster conversation (every ended one, since the boot payload went
  // non-ended-only) arrives via the store's lazy hydrate. Until it lands the
  // view has nothing to render -- it used to return null, i.e. a blank page.
  const hydrating = useConversationsStore(state => state.hydratingConversationId === conversationId)
  const permissions = usePermissions(conversationId)

  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab

  const events = useConversationsStore(state =>
    STREAMING_TABS.has(activeTabRef.current) ? state.events[conversationId] || EMPTY_EVENTS : EMPTY_EVENTS,
  )
  const transcript = useConversationsStore(state => {
    const tab = activeTabRef.current
    if (tab !== 'transcript' && tab !== 'tty') return EMPTY_TRANSCRIPT
    return state.transcripts[conversationId] || EMPTY_TRANSCRIPT
  })
  const sentinelConnected = useConversationsStore(state => state.sentinelConnected)
  const projectSettings = useConversationsStore(state =>
    conversation?.project ? state.projectSettings[projectIdentityKey(conversation.project)] : undefined,
  )

  // The model the session BOOTED with, which is not always the one on the
  // conversation record (a mid-session /model switch never rewrites it).
  const model = (events.find(e => e.hookEvent === 'SessionStart')?.data as { model?: string } | undefined)?.model

  return {
    ...permissions,
    model,
    showThinking,
    showDiag,
    showTerminal,
    terminalWrapperId,
    expandAll,
    conversation,
    hydrating,
    events,
    transcript,
    sentinelConnected,
    projectSettings,
  }
}
