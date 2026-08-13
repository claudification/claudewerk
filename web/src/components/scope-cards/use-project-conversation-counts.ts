import { projectIdentityKey } from '@shared/project-uri'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'

/**
 * Who is working in this PLACE right now -- active / idle / ended, per project.
 *
 * Active and idle are counted from the roster the panel holds, which is complete
 * for those two: the load payload carries every non-ended conversation.
 *
 * ENDED is different. Those rows are no longer shipped on load (they were 97.7%
 * of the payload), so the bulk of the count comes from the broker aggregate. A
 * conversation that ends DURING this session is still in the local roster and is
 * not yet in that aggregate, so the two are added. A reconnect replaces the
 * roster and refreshes the aggregate together, so nothing is counted twice.
 *
 * Keyed on `projectIdentityKey`, so a conversation working in an in-repo
 * worktree counts for its repo (the same fold every other comparator uses).
 * Returns a tuple through `useShallow` -- a fresh object literal out of a
 * zustand selector re-renders forever (React #185).
 */
export interface ConversationCounts {
  active: number
  idle: number
  ended: number
}

export function useProjectConversationCounts(projectUri: string): ConversationCounts {
  const [active, idle, ended] = useConversationsStore(
    useShallow(s => {
      const key = projectIdentityKey(projectUri)
      let a = 0
      let i = 0
      let endedThisSession = 0
      for (const conv of Object.values(s.conversationsById)) {
        if (projectIdentityKey(conv.project) !== key) continue
        if (conv.status === 'ended') endedThisSession++
        else if (conv.status === 'active') a++
        else i++
      }

      // The aggregate is keyed by raw project URI, so fold it the same way the
      // roster is folded -- otherwise a worktree's ended conversations go
      // missing from its repo's badge.
      let endedOnServer = 0
      for (const [uri, count] of Object.entries(s.endedCountsByProject)) {
        if (projectIdentityKey(uri) === key) endedOnServer += count
      }

      return [a, i, endedOnServer + endedThisSession]
    }),
  )
  return { active, idle, ended }
}
