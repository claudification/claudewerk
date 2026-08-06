/**
 * THE JOIN, as a UI affordance: from a commit back to the conversation and the
 * exact transcript position at the moment it committed.
 *
 * The anchor is resolved lazily on mount (the row is already expanded by then),
 * so a list of 200 commits costs zero extra requests until one is opened.
 */

import { MessageSquareText } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { type CommitTranscriptLink, fetchCommitTranscript } from '@/lib/commits'
import { haptic } from '@/lib/utils'

interface Props {
  hash: string
  conversationId: string
  conversationName: string | null
}

export function CommitTranscriptLinkRow({ hash, conversationId, conversationName }: Props) {
  const [link, setLink] = useState<CommitTranscriptLink | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchCommitTranscript(hash).then(result => {
      if (!cancelled) setLink(result)
    })
    return () => {
      cancelled = true
    }
  }, [hash])

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={() => {
          haptic('tap')
          useConversationsStore.getState().selectConversation(conversationId, 'commit-ledger')
        }}
        className="flex items-center gap-1.5 text-[10px] text-accent hover:underline"
      >
        <MessageSquareText className="size-3" />
        Open the conversation that made this{conversationName ? ` (${conversationName})` : ''}
      </button>
      {link?.anchor && (
        <div className="text-[9px] font-mono text-muted-foreground/50 pl-[18px]">
          transcript position seq {link.anchor.seq} - {new Date(link.anchor.timestamp).toLocaleString()}
        </div>
      )}
    </div>
  )
}
