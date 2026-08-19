/**
 * A1's feed: the four pending-interaction slices plus the fleet itself, folded
 * into one queue by `attention-queue.ts`.
 *
 * The store actions are read at CLICK time through `getState()` rather than
 * captured into the memo. Two reasons: the closures then never enter a
 * dependency list (the queue would rebuild on every store write otherwise), and
 * an answer always travels through whatever the store holds NOW -- which is what
 * a test replacing one action with a spy depends on.
 *
 * Per `feedback_zustand_no_object_selectors`, one field per selector: a
 * `useShallow` bundle here would re-render this pane on every unrelated write.
 */

import { useMemo } from 'react'
import { useAttentionFlags } from '@/components/pulse/use-attention-flags'
import { useConversations, useConversationsStore } from '@/hooks/use-conversations'
import type { AttentionAnswers, AttentionEntry } from './attention-entries'
import { buildAttentionQueue } from './attention-queue'

/**
 * The real paths, late-bound. Module scope so its identity never churns.
 *
 * Every entry forwards its arguments UNTOUCHED -- no defaults filled in, no
 * extra trailing `undefined`. What the pane sends is exactly what the
 * transcript's own button sends, which is the whole claim this pane makes.
 */
export const STORE_ANSWERS: AttentionAnswers = {
  respondToPermission: (...a) => useConversationsStore.getState().respondToPermission(...a),
  allowPermissionAlways: (...a) => useConversationsStore.getState().allowPermissionAlways(...a),
  respondToProjectLink: (...a) => useConversationsStore.getState().respondToProjectLink(...a),
  respondToAskQuestion: (...a) => useConversationsStore.getState().respondToAskQuestion(...a),
  submitDialog: (...a) => useConversationsStore.getState().submitDialog(...a),
  respondToSpawnApproval: (...a) => useConversationsStore.getState().respondToSpawnApproval(...a),
}

export function useAttentionQueue(now: number): AttentionEntry[] {
  const permissions = useConversationsStore(s => s.pendingPermissions)
  const links = useConversationsStore(s => s.pendingProjectLinks)
  const asks = useConversationsStore(s => s.pendingAskQuestions)
  const dialogs = useConversationsStore(s => s.pendingDialogs)
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const conversations = useConversations()
  const flagsFor = useAttentionFlags()

  return useMemo(
    () =>
      buildAttentionQueue({
        permissions,
        links,
        asks,
        dialogs,
        conversations,
        projectSettings,
        flagsFor,
        answers: STORE_ANSWERS,
        now,
      }),
    [permissions, links, asks, dialogs, conversations, projectSettings, flagsFor, now],
  )
}
