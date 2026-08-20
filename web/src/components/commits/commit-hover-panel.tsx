/**
 * A commit under the pointer: the FULL message body and the file stat summary.
 *
 * The river row shows a subject truncated to a column and a `+n -n` pair. The
 * two questions that leaves open -- what does the rest of the message say, and
 * what did it actually touch -- are the two this answers, which is why the body
 * is not clamped and the file list is.
 *
 * Same frame and the same fetch as the full detail surface (`useCommitDetail`),
 * so a hover and a click never disagree about what a commit is.
 */

import { HoverFrame, HoverSection } from '@/components/card-hover/card-hover-parts'
import { commitTypeColor } from '@/lib/commits'
import { cn } from '@/lib/utils'
import { useCommitDetail } from './use-commit-detail'

/** Enough to see the shape of the change; the detail surface has the rest. */
const FILES_SHOWN = 8

export function CommitHoverPanel({ hash }: { hash: string }) {
  const detail = useCommitDetail(hash)

  if (detail.status === 'loading') return <HoverNote>resolving {hash.slice(0, 8)}...</HoverNote>
  if (detail.status === 'missing') return <HoverNote>no commit matches {hash.slice(0, 8)}</HoverNote>

  const commit = detail.commit
  const rest = commit.fileCount - Math.min(commit.files.length, FILES_SHOWN)

  return (
    <HoverFrame>
      <HoverSection className="space-y-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] text-muted-foreground shrink-0">{commit.shortHash}</span>
          <span className="font-mono text-[10px] text-muted-foreground truncate">{commit.branch}</span>
        </div>
        <div className={cn('leading-snug break-words', commitTypeColor(commit.ccType))}>{commit.subject}</div>
      </HoverSection>

      {commit.body && (
        <HoverSection className="text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
          {commit.body.trim()}
        </HoverSection>
      )}

      <HoverSection className="space-y-1">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>
            {commit.fileCount} file{commit.fileCount === 1 ? '' : 's'}
          </span>
          <span className="text-emerald-400/70">+{commit.insertions}</span>
          <span className="text-rose-400/70">-{commit.deletions}</span>
        </div>
        {commit.files.slice(0, FILES_SHOWN).map(file => (
          <div key={`${file.status}:${file.path}`} className="flex items-center gap-2 font-mono text-[10px]">
            <span className="w-4 shrink-0 text-muted-foreground">{file.status}</span>
            <span className="truncate">{file.path}</span>
          </div>
        ))}
        {rest > 0 && <div className="font-mono text-[10px] text-muted-foreground">+{rest} more</div>}
      </HoverSection>
    </HoverFrame>
  )
}

function HoverNote({ children }: { children: React.ReactNode }) {
  return (
    <HoverFrame>
      <HoverSection className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {children}
      </HoverSection>
    </HoverFrame>
  )
}
