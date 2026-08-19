import { useCallback, useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { PulseAttentionFlags } from '@/lib/pulse/bands'

/**
 * THE SECOND PATH.
 *
 * Every blocking interaction the broker knows about is also mirrored in the
 * panel's own store, arriving as its own wire message. Reading those maps gives
 * Pulse a source of truth independent of `conversation.pendingAttention` — the
 * denormalized umbrella that on 2026-08-19 was cleared 200 ms after being set,
 * taking an open dialog off every surface at once.
 *
 * Sets are derived in memos rather than returned straight from the selectors: a
 * selector that builds a new Set re-fires on every render (React #185).
 */
export function useAttentionFlags(): (conversationId: string) => PulseAttentionFlags {
  const pendingPermissions = useConversationsStore(s => s.pendingPermissions)
  const pendingProjectLinks = useConversationsStore(s => s.pendingProjectLinks)
  const pendingAskQuestions = useConversationsStore(s => s.pendingAskQuestions)
  const pendingDialogs = useConversationsStore(s => s.pendingDialogs)

  const permissionIds = useMemo(() => new Set(pendingPermissions.map(p => p.conversationId)), [pendingPermissions])
  const askIds = useMemo(() => new Set(pendingAskQuestions.map(q => q.conversationId)), [pendingAskQuestions])

  // An EXPIRED dialog no longer blocks — it renders as a re-displayable pill and
  // the agent has already moved on, so it must not hold the conversation in the
  // blocked band forever.
  const dialogIds = useMemo(
    () =>
      new Set(
        Object.entries(pendingDialogs)
          .filter(([, d]) => !d.expired)
          .map(([id]) => id),
      ),
    [pendingDialogs],
  )

  const linkIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of pendingProjectLinks) {
      ids.add(r.fromConversation)
      ids.add(r.toConversation)
    }
    return ids
  }, [pendingProjectLinks])

  return useCallback(
    (id: string): PulseAttentionFlags => ({
      hasPendingPermission: permissionIds.has(id),
      hasPendingLink: linkIds.has(id),
      hasOpenDialog: dialogIds.has(id),
      hasPendingAsk: askIds.has(id),
    }),
    [permissionIds, linkIds, dialogIds, askIds],
  )
}
