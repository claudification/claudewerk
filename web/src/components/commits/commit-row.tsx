/**
 * One commit in the ledger: hash, message, the files it touched, and where it
 * came from. Expanding a row reveals the full file list plus the jump back into
 * the conversation that produced it.
 */

import { GitCommitHorizontal } from 'lucide-react'
import { useState } from 'react'
import { type CommitRow, commitAge, commitTypeColor } from '@/lib/commits'
import { cn, haptic } from '@/lib/utils'
import { CommitTranscriptLinkRow } from './commit-transcript-link'

const KIND_BADGES: Record<string, string> = {
  merge: 'bg-violet-500/20 text-violet-300',
  revert: 'bg-rose-500/20 text-rose-300',
  amend: 'bg-amber-500/20 text-amber-300',
  rebase: 'bg-sky-500/20 text-sky-300',
  initial: 'bg-emerald-500/20 text-emerald-300',
}

export function CommitRowItem({ commit, showProject }: { commit: CommitRow; showProject?: boolean }) {
  const [open, setOpen] = useState(false)
  const badge = KIND_BADGES[commit.kind]

  return (
    <div className="border border-border hover:border-accent/40 transition-colors">
      <button
        type="button"
        onClick={() => {
          haptic('tick')
          setOpen(o => !o)
        }}
        className="w-full text-left px-3 py-2 space-y-1"
      >
        <div className="flex items-center gap-2">
          <GitCommitHorizontal className={cn('size-3 shrink-0', commitTypeColor(commit.ccType))} />
          <span className="font-mono text-[10px] text-muted-foreground/70 shrink-0">{commit.shortHash}</span>
          <span className="text-xs truncate flex-1">{commit.subject}</span>
          {badge && <span className={cn('px-1 text-[9px] font-bold uppercase shrink-0', badge)}>{commit.kind}</span>}
          <span className="text-[10px] text-muted-foreground/70 shrink-0">{commitAge(commit.committedAt)}</span>
        </div>
        <div className="flex items-center gap-2 text-[9px] font-mono text-muted-foreground/50 uppercase tracking-wide">
          <span className={commit.origin === 'agent' ? 'text-accent/70' : ''}>{commit.origin}</span>
          <span>{commit.branch}</span>
          <span>
            {commit.fileCount} file{commit.fileCount === 1 ? '' : 's'}
          </span>
          {(commit.insertions > 0 || commit.deletions > 0) && (
            <span>
              <span className="text-emerald-400/70">+{commit.insertions}</span>{' '}
              <span className="text-rose-400/70">-{commit.deletions}</span>
            </span>
          )}
          <span className="truncate">{commit.host}</span>
          {commit.container && <span className="text-orange-400/60">container</span>}
          {showProject && <span className="truncate">{commit.repoName}</span>}
        </div>
      </button>

      {open && (
        <div className="px-3 pb-2 space-y-2 border-t border-border/50 pt-2">
          {commit.body && (
            <pre className="text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap font-sans">
              {commit.body}
            </pre>
          )}
          <div className="space-y-0.5">
            {commit.files.map(f => (
              <div key={`${f.status}:${f.path}`} className="flex items-center gap-2 text-[10px] font-mono">
                <span className="w-6 shrink-0 text-muted-foreground/60">{f.status}</span>
                <span className="truncate">{f.path}</span>
              </div>
            ))}
            {commit.filesTruncated && (
              <div className="text-[10px] text-amber-400/70">
                showing 500 of {commit.fileCount} files (the rest were not stored)
              </div>
            )}
          </div>
          {commit.conversationId && (
            <CommitTranscriptLinkRow
              hash={commit.hash}
              conversationId={commit.conversationId}
              conversationName={commit.conversationName}
            />
          )}
        </div>
      )}
    </div>
  )
}
