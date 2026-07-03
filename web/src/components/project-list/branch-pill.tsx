import { GitBranch } from 'lucide-react'
import { worktreeName } from '@/components/conversation-detail/header-info-helpers'
import { isShareView } from '@/lib/share-mode'
import type { Conversation } from '@/lib/types'
import { projectPath } from '@/lib/types'
import { cn } from '@/lib/utils'

type BranchKind = 'worktree' | 'worktree-adhoc' | 'branch'

interface ResolvedBranch {
  label: string
  kind: BranchKind
  title: string
}

/** Resolve a conversation's branch/worktree label. Prefers the LIVE worktree
 *  (from `currentPath`, updated via `cwd_changed`) over the sticky `gitBranch`.
 *  Returns null when there's nothing worth showing -- a base branch
 *  (`main`/`master`) or no branch at all -- so those rows stay clean. Worktree/
 *  path-derived labels are hidden from share guests (the header redacts host
 *  disk paths); a plain branch name is not a path, so it stays. */
export function resolveBranch(conversation: Conversation): ResolvedBranch | null {
  if (!isShareView()) {
    const cur = conversation.currentPath
    const wt = cur && cur !== projectPath(conversation.project) ? worktreeName(cur) : null
    if (wt) return { label: wt, kind: 'worktree', title: `Working in worktree ${wt}` }
    if (conversation.adHocWorktree)
      return {
        label: conversation.adHocWorktree,
        kind: 'worktree-adhoc',
        title: `Ad-hoc worktree ${conversation.adHocWorktree}`,
      }
  }
  const branch = conversation.gitBranch
  if (branch && branch !== 'main' && branch !== 'master')
    return { label: branch, kind: 'branch', title: `Branch ${branch}` }
  return null
}

const INLINE_COLOR: Record<BranchKind, string> = {
  worktree: 'text-violet-300/80',
  'worktree-adhoc': 'text-orange-400/70',
  branch: 'text-purple-400/70',
}

const PILL_COLOR: Record<BranchKind, string> = {
  worktree: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  'worktree-adhoc': 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  branch: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
}

/** Shared branch/worktree indicator. `compact` = inline text for list rows;
 *  default = the bordered pill used in the conversation-detail header. Single
 *  source of truth so list rows and header never disagree on the label. */
export function BranchPill({ conversation, compact = false }: { conversation: Conversation; compact?: boolean }) {
  const r = resolveBranch(conversation)
  if (!r) return null
  if (compact) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-0.5 text-[9px] font-mono truncate max-w-[10rem]',
          INLINE_COLOR[r.kind],
        )}
        title={r.title}
      >
        <GitBranch className="size-2.5 shrink-0" />
        <span className="truncate">{r.label}</span>
      </span>
    )
  }
  return (
    <span
      className={cn(
        'shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 rounded border text-[10px] font-mono max-w-[10rem]',
        PILL_COLOR[r.kind],
      )}
      title={r.title}
    >
      <GitBranch className="size-3 shrink-0" />
      <span className="truncate">{r.label}</span>
    </span>
  )
}
