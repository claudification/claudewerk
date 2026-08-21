/**
 * The conversation the panel is currently pointed at.
 *
 * TWO subscriptions, not one, and that is deliberate: a single selector
 * returning `{ id, conversation }` would build a new object literal every call
 * and re-render on every store touch (React #185 -- see the Zustand rule in the
 * covenants). Two primitive/reference selectors each stay referentially stable.
 *
 * Extracted because the pair had been copy-pasted into `action-fab` and the
 * Quick Task hook verbatim; both wanted the same two lines and neither could
 * see the other's copy.
 */

import { useConversationsStore } from './use-conversations'

export function useSelectedConversation() {
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const conversation = useConversationsStore(state =>
    state.selectedConversationId ? state.conversationsById[state.selectedConversationId] : undefined,
  )
  return { selectedConversationId, conversation }
}
