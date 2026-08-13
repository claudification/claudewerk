import { memo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { ConversationItemCompact } from './conversation-item-compact'

export { ConversationItemCompact } from './conversation-item-compact'
export { SpawnRootStub } from './conversation-item-helpers'

// ─── Compact peek (used for the "selected conversation" preview inside a
// collapsed group). Subscribes to a single conversation by id so the peek
// re-renders independently of ProjectList. ──────────────────────────

export const ConversationCompactPeek = memo(function ConversationCompactPeek({
  conversationId,
}: {
  conversationId: string
}) {
  const conversation = useConversationsStore(s => s.conversationsById[conversationId])
  if (!conversation) return null
  return <ConversationItemCompact conversation={conversation} />
})
