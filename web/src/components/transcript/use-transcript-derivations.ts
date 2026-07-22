/**
 * Pure derivations shared by both transcript renderers. Virtualizer-agnostic:
 * a transcript-settings projection off the store, the main/queued group split
 * + live-turn signal, and the ExitPlanMode plan-content scan over the entries.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { TranscriptAssistantEntry, TranscriptEntry } from '@/lib/types'
import type { TranscriptSettings } from './group-view-types'
import { type DisplayGroup, groupIdentityKey } from './grouping'

/**
 * How long the conversation must sit idle before a still-flagged queued group
 * is declared stale.
 *
 * CC drains its queue almost immediately once a turn ends -- measured at ~145ms
 * (Stop hook 147.374 -> queue drained 147.519 on CC 2.1.215). Seconds of idle
 * with something still marked queued is therefore a contradiction, not a slow
 * hand-off. 4s is generous margin over that while still clearing well within a
 * human's attention span.
 */
const QUEUED_IDLE_STALE_MS = 4000

/** Split queued groups (float at the bottom) from the main stream, and derive
 *  whether a turn is live (active conversation OR streaming buffers present).
 *
 *  Also reaps stale queued flags. The badge is cleared by a `remove`/`dequeue`
 *  entry from CC, and if that entry never lands -- dropped on a WS gap, the host
 *  dying mid-turn, an evicted ring-buffer slot -- the group floats as "queued"
 *  forever. `grouping.tsx` already clears orphans on a reset/refetch, which
 *  covers a late joiner loading fresh; this covers the live incremental client,
 *  which otherwise keeps the ghost until something forces a regroup.
 *
 *  The invariant is `idle => nothing queued`, and it deliberately keys on IDLE
 *  rather than on "the user posted". The queue is FIFO and holds more than one
 *  message: clearing on every user post would wipe message A's badge the moment
 *  the user queues B behind it, while A is still legitimately waiting. A post
 *  while idle is just one more way of observing idle, so it falls out for free.
 *
 *  Staleness is STICKY per group key. Without that the ghost resurrects the
 *  instant the next turn starts: the grouping cache still holds `queued: true`,
 *  so a clear that keys only on the current idle state gets un-suppressed as
 *  soon as `liveActive` flips back. */
export function useLiveGroups(
  groups: DisplayGroup[],
  conversationId: string,
): { mainGroups: DisplayGroup[]; queuedGroups: DisplayGroup[]; liveActive: boolean } {
  const convActive = useConversationsStore(state => state.conversationsById[conversationId]?.status === 'active')
  const streamingPresent = useConversationsStore(
    state => !!(state.streamingText[conversationId] || state.streamingThinking[conversationId]),
  )
  const liveActive = convActive || streamingPresent

  const staleKeysRef = useRef<Set<string>>(new Set())
  const [staleEpoch, setStaleEpoch] = useState(0)

  // Switching conversations retires the old conversation's verdicts -- the keys
  // are only meaningful within one transcript.
  const lastConversationRef = useRef(conversationId)
  if (lastConversationRef.current !== conversationId) {
    lastConversationRef.current = conversationId
    staleKeysRef.current = new Set()
  }

  // staleEpoch is not read in the body on purpose -- it is the signal that
  // staleKeysRef was mutated, and dropping it freezes the split on the pre-reap
  // verdict.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const { mainGroups, queuedGroups } = useMemo(() => {
    const main: DisplayGroup[] = []
    const queued: DisplayGroup[] = []
    for (const g of groups) {
      if (!g.queued) {
        main.push(g)
      } else if (staleKeysRef.current.has(groupIdentityKey(g))) {
        // Replace rather than mutate: the cache owns this object and a
        // currently-rendering tree must not be disturbed (React #300).
        main.push({ ...g, queued: false })
      } else {
        queued.push(g)
      }
    }
    return { mainGroups: main, queuedGroups: queued }
    // staleEpoch is a dependency by design: the ref mutation above is what the
    // memo must react to.
  }, [groups, staleEpoch])

  useEffect(() => {
    if (liveActive || queuedGroups.length === 0) return
    const timer = setTimeout(() => {
      for (const g of queuedGroups) staleKeysRef.current.add(groupIdentityKey(g))
      setStaleEpoch(e => e + 1)
    }, QUEUED_IDLE_STALE_MS)
    return () => clearTimeout(timer)
  }, [liveActive, queuedGroups])

  return { mainGroups, queuedGroups, liveActive }
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
