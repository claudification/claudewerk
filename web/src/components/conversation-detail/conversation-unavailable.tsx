/**
 * What the detail pane shows when `conversationsById` has no entry for the
 * selected id.
 *
 * Before this it showed NOTHING -- `if (!conversation) return null` -- which is
 * how clicking a transcript-search hit for an ended conversation produced a
 * blank page with no error anywhere. Two honest outcomes instead: the fetch is
 * in flight, or the conversation is genuinely gone.
 */

import { useConversationsStore } from '@/hooks/use-conversations'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center text-muted-foreground text-sm gap-2">
      {children}
    </div>
  )
}

export function ConversationLoading() {
  return (
    <Frame>
      <span className="inline-block size-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
      Loading conversation...
    </Frame>
  )
}

export function ConversationNotFound({ conversationId }: { conversationId: string }) {
  const selectConversation = useConversationsStore(s => s.selectConversation)
  return (
    <Frame>
      <div className="text-center">
        <div>Conversation not found</div>
        <div className="text-xs text-comment font-mono mt-1">{conversationId}</div>
        <button
          type="button"
          className="mt-3 text-xs text-primary hover:underline cursor-pointer"
          onClick={() => selectConversation(null, 'not-found-dismiss')}
        >
          Back
        </button>
      </div>
    </Frame>
  )
}
