/**
 * Pure derivations shared by both transcript renderers. Virtualizer-agnostic:
 * a transcript-settings projection off the store, the main/queued group split
 * + live-turn signal, and the ExitPlanMode plan-content scan over the entries.
 */

import { useMemo, useRef } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { TranscriptAssistantEntry, TranscriptEntry } from '@/lib/types'
import type { TranscriptSettings } from './group-view-types'
import type { DisplayGroup } from './grouping'

/** Split queued groups (float at the bottom) from the main stream, and derive
 *  whether a turn is live (active conversation OR streaming buffers present). */
export function useLiveGroups(
  groups: DisplayGroup[],
  conversationId: string,
): { mainGroups: DisplayGroup[]; queuedGroups: DisplayGroup[]; liveActive: boolean } {
  const { mainGroups, queuedGroups } = useMemo(() => {
    const main: DisplayGroup[] = []
    const queued: DisplayGroup[] = []
    for (const g of groups) {
      if (g.queued) queued.push(g)
      else main.push(g)
    }
    return { mainGroups: main, queuedGroups: queued }
  }, [groups])
  const convActive = useConversationsStore(state => state.conversationsById[conversationId]?.status === 'active')
  const streamingPresent = useConversationsStore(
    state => !!(state.streamingText[conversationId] || state.streamingThinking[conversationId]),
  )
  return { mainGroups, queuedGroups, liveActive: convActive || streamingPresent }
}

/** Lift the per-group display settings ONCE (instead of per-GroupView). Returns
 *  a memoized object stable across renders when the underlying store slices are
 *  unchanged, so it doesn't bust the GroupView memo. */
export function useTranscriptSettings(): TranscriptSettings {
  const expandAll = useConversationsStore(state => state.expandAll)
  const globalSettings = useConversationsStore(state => state.globalSettings)
  const chatBubbles = useConversationsStore(state => state.controlPanelPrefs.chatBubbles)
  const bubbleColor = useConversationsStore(state => state.controlPanelPrefs.chatBubbleColor) || 'blue'
  return useMemo<TranscriptSettings>(
    () => ({
      expandAll,
      userLabel: (globalSettings.userLabel as string)?.trim() || 'USER',
      agentLabel: (globalSettings.agentLabel as string)?.trim() || 'CLAUDE',
      userColor: (globalSettings.userColor as string)?.trim() || '',
      agentColor: (globalSettings.agentColor as string)?.trim() || '',
      userSize: (globalSettings.userSize as string) || '',
      agentSize: (globalSettings.agentSize as string) || '',
      chatBubbles,
      bubbleColor,
    }),
    [expandAll, globalSettings, chatBubbles, bubbleColor],
  )
}

/** Extract plan content for ExitPlanMode display: the last Write to a
 *  `plans/*.md` path across all entries. Returns a STABLE reference when the
 *  content hasn't changed so it doesn't bust the memo on every GroupView. */
export function usePlanContext(entries: TranscriptEntry[]): { content: string; path?: string } | undefined {
  const planContextRef = useRef<{ content: string; path?: string } | undefined>(undefined)
  return useMemo(() => {
    let content: string | undefined
    let path: string | undefined
    for (const entry of entries) {
      if (entry.type !== 'assistant') continue
      const msg = (entry as TranscriptAssistantEntry).message
      if (!msg) continue
      const blocks = msg.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.name === 'Write' && block.input) {
          const filePath = block.input.file_path as string
          if (filePath && /plans\/[^/]+\.md$/.test(filePath)) {
            content = block.input.content as string
            path = filePath
          }
        }
      }
    }
    const next = content ? { content, path } : undefined
    const prev = planContextRef.current
    if (prev?.content === next?.content && prev?.path === next?.path) return prev
    planContextRef.current = next
    return next
  }, [entries])
}
