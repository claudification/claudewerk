/**
 * The subagent transcript pane, owning its own fetch.
 *
 * Split out of conversation-detail.tsx (over the .tsx line bar). Pulling
 * useSubagentFetch down here means the parent only reads `selectedSubagentId`
 * to decide which pane to show -- the transcript, its loading flag and the
 * back-navigation never travel through the parent at all.
 */

import type { Conversation } from '@/lib/types'
import { SubagentDetailView } from './subagent-detail-view'
import { useSubagentFetch } from './use-subagent-fetch'

interface SubagentPaneProps {
  conversation: Conversation
  subagentId: string
  showThinking: boolean
  follow: boolean
  onBack: () => void
  onUserScroll: () => void
  onReachedBottom: () => void
}

export function SubagentPane({
  conversation,
  subagentId,
  showThinking,
  follow,
  onBack,
  onUserScroll,
  onReachedBottom,
}: SubagentPaneProps) {
  const { subagentTranscript, subagentLoading } = useSubagentFetch(conversation.id)
  return (
    <SubagentDetailView
      conversationId={conversation.id}
      subagent={conversation.subagents.find(a => a.agentId === subagentId)}
      subagentId={subagentId}
      transcript={subagentTranscript}
      loading={subagentLoading}
      showThinking={showThinking}
      follow={follow}
      onBack={onBack}
      onUserScroll={onUserScroll}
      onReachedBottom={onReachedBottom}
    />
  )
}
