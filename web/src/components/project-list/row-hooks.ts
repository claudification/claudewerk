import { projectIdentityKey } from '@shared/project-uri'
import { useLayoutEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useGhostShort } from '@/hooks/use-ghost-sessions'
import { deriveContextPct, deriveCostInfo } from '@/lib/conversation-row'
import { getCacheTimerInfo } from '@/lib/cost-utils'
import { tallyListRender } from '@/lib/perf-metrics'
import type { Conversation } from '@/lib/types'

/**
 * Shared store subscriptions + derivations for a conversation list row. Both the
 * compact row and the status-rail row read through this so the subscribe/derive
 * layer lives in ONE place (see feedback_no_duplication). Component-specific
 * selectors (rename state, mobile, openTab, ...) stay in the components.
 */
export function useConversationRowData(conversation: Conversation) {
  // Perf instrumentation: tally committed re-renders of this leaf so a capture can
  // tell a memo leak (rows storm per store update) from selector churn. No-op
  // unless the perf monitor is on.
  useLayoutEffect(() => {
    tallyListRender('row')
  })
  const isSelected = useConversationsStore(s => s.selectedConversationId === conversation.id)
  const selectedSubagentId = useConversationsStore(s =>
    s.selectedConversationId === conversation.id ? s.selectedSubagentId : null,
  )
  const ps = useConversationsStore(s => s.projectSettings[projectIdentityKey(conversation.project)])
  const showCost = useConversationsStore(s => s.controlPanelPrefs.showCostInList)
  const showContextBar = useConversationsStore(s => s.controlPanelPrefs.showContextInList)
  const ghostShort = useGhostShort(conversation.id)
  const isGhost = !!ghostShort && (conversation.connectionIds?.length ?? 0) === 0
  const ctx = showContextBar ? deriveContextPct(conversation) : null
  const costInfo = showCost ? deriveCostInfo(conversation) : null
  const cacheInfo =
    conversation.status === 'idle'
      ? getCacheTimerInfo(
          conversation.lastTurnEndedAt,
          conversation.tokenUsage,
          conversation.model,
          conversation.cacheTtl,
        )
      : null
  return { isSelected, selectedSubagentId, ps, displayColor: ps?.color, isGhost, ctx, costInfo, cacheInfo }
}

/** Hydrate Conversations from the per-id index with a shallow-equal short-circuit
 *  (so the list re-renders only when a referenced conversation's identity changes). */
export function useHydratedConversations(ids: string[]): Conversation[] {
  return useConversationsStore(
    useShallow(s => {
      const out: Conversation[] = []
      for (const id of ids) {
        const c = s.conversationsById[id]
        if (c) out.push(c)
      }
      return out
    }),
  )
}
