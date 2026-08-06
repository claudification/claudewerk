/**
 * The group header for one run: project, conversation, liveness.
 *
 * Both halves are click-throughs -- project opens the project panel,
 * conversation opens that conversation EVEN IF IT HAS ENDED (the ledger
 * outlives its conversations, and the dead ones are exactly the ones you need
 * to go read).
 */

import { FolderGit2, MessageSquareText } from 'lucide-react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { cn, haptic } from '@/lib/utils'
import type { ConversationDecoration, ProjectDecoration } from './use-commit-feed'

/** Liveness at a glance. `gone` is its own state: the conversation is no longer
 *  in the registry at all, which is information, not an error. */
const STATUS_PILL: Record<string, string> = {
  active: 'bg-emerald-500/20 text-emerald-300',
  idle: 'bg-amber-500/20 text-amber-300',
  ended: 'bg-muted text-muted-foreground',
  gone: 'bg-rose-500/10 text-rose-300/70',
}

interface Props {
  projectUri: string
  conversationId: string | null
  project?: ProjectDecoration
  conversation?: ConversationDecoration
  /** The previous run had the same project -- keep the header but mute it. */
  continuesProject: boolean
  onOpenProject: (uri: string) => void
}

export function CommitRunHeader({
  projectUri,
  conversationId,
  project,
  conversation,
  continuesProject,
  onOpenProject,
}: Props) {
  const status = conversation?.status ?? 'gone'
  const label = conversation?.name || conversation?.title || conversationId?.slice(0, 8)

  return (
    <div className="flex items-center gap-2 pt-2 pb-1">
      <button
        type="button"
        onClick={() => {
          haptic('tap')
          onOpenProject(projectUri)
        }}
        className={cn(
          'flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider transition-colors hover:text-foreground',
          continuesProject ? 'text-muted-foreground/50' : 'text-sky-400/80',
        )}
      >
        <FolderGit2 className="size-3" />
        {project?.label ?? projectUri}
      </button>

      <span className="text-muted-foreground/30">/</span>

      {conversationId ? (
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            // Works for an ENDED conversation too -- selecting it loads the
            // stored transcript; liveness only decides the pill, not access.
            useConversationsStore.getState().selectConversation(conversationId, 'commit-browser')
          }}
          className="flex items-center gap-1.5 text-[11px] text-foreground/80 hover:text-foreground hover:underline"
        >
          <MessageSquareText className="size-3" />
          {label}
        </button>
      ) : (
        <span className="text-[11px] text-muted-foreground/70">terminal (human)</span>
      )}

      <span className={cn('px-1 text-[9px] font-bold uppercase', STATUS_PILL[status] ?? STATUS_PILL.gone)}>
        {status}
      </span>
      <span className="flex-1 h-px bg-border/50" />
    </div>
  )
}
