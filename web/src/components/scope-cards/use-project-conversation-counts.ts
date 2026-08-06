import { projectIdentityKey } from '@shared/project-uri'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'

/**
 * Who is working in this PLACE right now -- active / idle / ended, derived from
 * the roster the panel already holds. No fetch: the sidebar knows every
 * conversation, it just never counted them per project.
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
      let e = 0
      for (const conv of Object.values(s.conversationsById)) {
        if (projectIdentityKey(conv.project) !== key) continue
        if (conv.status === 'ended') e++
        else if (conv.status === 'active') a++
        else i++
      }
      return [a, i, e]
    }),
  )
  return { active, idle, ended }
}
