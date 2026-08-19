/**
 * The one-line identity of a commit: type-coloured icon, short hash, subject,
 * kind badge. Shared by the expandable list row and the browser's feed row so
 * a commit reads identically wherever it appears.
 */

import { GitCommitHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import type { CommitRow } from '@/lib/commits'
import { commitTypeColor } from '@/lib/commits'
import { cn } from '@/lib/utils'

/** Kinds worth flagging. `normal` is the overwhelming majority and gets no
 *  badge -- a badge on everything is a badge on nothing. */
const KIND_BADGES: Record<string, string> = {
  merge: 'bg-violet-500/20 text-violet-300',
  revert: 'bg-rose-500/20 text-rose-300',
  amend: 'bg-amber-500/20 text-amber-300',
  rebase: 'bg-sky-500/20 text-sky-300',
  initial: 'bg-emerald-500/20 text-emerald-300',
}

export function CommitSummaryLine({ commit, trailing }: { commit: CommitRow; trailing?: ReactNode }) {
  const badge = KIND_BADGES[commit.kind]
  return (
    <div className="flex items-center gap-2 min-w-0">
      <GitCommitHorizontal className={cn('size-3 shrink-0', commitTypeColor(commit.ccType))} />
      <span className="font-mono text-[10px] text-fg-muted shrink-0">{commit.shortHash}</span>
      <span className="text-xs truncate flex-1">{commit.subject}</span>
      {badge && <span className={cn('px-1 text-[9px] font-bold uppercase shrink-0', badge)}>{commit.kind}</span>}
      {trailing}
    </div>
  )
}
