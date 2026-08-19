import { GitBranch } from 'lucide-react'
import { useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { haptic } from '@/lib/utils'

/**
 * Header card for a forked conversation.
 *
 * Replaces the raw `<forked ...>` block plus the fold's machine-written
 * preamble, which would otherwise be the first thing a human reads in every
 * forked conversation. The parent is a click away; the preamble is still
 * available behind a toggle rather than deleted, since it lists exactly which
 * tool outputs were folded.
 */
export function ForkBanner({
  conversationId,
  conversationName,
  preamble,
}: {
  conversationId: string
  conversationName?: string
  preamble?: string
}) {
  const [open, setOpen] = useState(false)
  const selectConversation = useConversationsStore(s => s.selectConversation)
  const parentExists = useConversationsStore(s => Boolean(s.conversationsById[conversationId]))
  const label = conversationName || `${conversationId.slice(0, 8)}`

  return (
    <div className="my-4 border border-cyan-400/30 bg-cyan-400/5 rounded">
      <div className="flex items-center gap-2 px-3 py-2">
        <GitBranch className="size-3.5 text-cyan-400 shrink-0" />
        <span className="text-[10px] font-bold font-mono uppercase tracking-widest text-cyan-400 shrink-0">
          forked from
        </span>
        {parentExists ? (
          <button
            type="button"
            onClick={() => {
              haptic('tap')
              selectConversation(conversationId, 'fork-banner')
            }}
            className="text-[11px] font-mono text-foreground hover:text-cyan-300 underline decoration-dotted underline-offset-2 truncate min-w-0"
            title={conversationId}
          >
            {label}
          </button>
        ) : (
          // The parent may be dismissed or on another host -- still name it, but
          // do not offer a jump that would land nowhere.
          <span className="text-[11px] font-mono text-muted-foreground truncate min-w-0" title={conversationId}>
            {label}
          </span>
        )}
        {preamble && (
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            className="ml-auto shrink-0 text-[9px] font-mono text-fg-muted hover:text-foreground transition-colors"
          >
            {open ? 'hide details' : 'what was folded'}
          </button>
        )}
      </div>
      {open && preamble && (
        <pre className="px-3 pb-2.5 text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">
          {preamble}
        </pre>
      )}
    </div>
  )
}
