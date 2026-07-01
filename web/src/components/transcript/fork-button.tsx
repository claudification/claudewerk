import { GitFork } from 'lucide-react'
import type { MouseEvent } from 'react'
import { forkConversation, useConversationsStore } from '@/hooks/use-conversations'

/**
 * "Fork from here" affordance on an assistant turn. Branches a NEW conversation
 * that replays the current conversation's history up to (and including) this
 * message; the source is untouched. Reveals on group hover to stay out of the
 * way. Reads the active conversationId from the store at CLICK time (no
 * subscription) so it adds zero re-render cost to the virtualized transcript.
 */
export function ForkButton({ atMessageUuid }: { atMessageUuid?: string }) {
  const onClick = (e: MouseEvent) => {
    e.stopPropagation()
    const conversationId = useConversationsStore.getState().selectedConversationId
    if (!conversationId) return
    forkConversation(conversationId, atMessageUuid)
    window.dispatchEvent(
      new CustomEvent('rclaude-toast', {
        detail: { title: 'Forking…', body: 'Branching a new conversation from here', variant: 'info' },
      }),
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title="Fork a new conversation from here"
      aria-label="Fork a new conversation from here"
      className="opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity text-muted-foreground hover:text-primary"
    >
      <GitFork className="w-3 h-3" />
    </button>
  )
}
