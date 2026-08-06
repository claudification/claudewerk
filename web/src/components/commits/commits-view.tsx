/**
 * The commit-ledger list. Drives both the conversation tab (scoped to one
 * conversation) and any project-scoped view, because the only difference
 * between them is which filter goes in.
 */

import { GitCommitHorizontal, Search } from 'lucide-react'
import { useState } from 'react'
import type { CommitListParams } from '@/lib/commits'
import { CommitRowItem } from './commit-row'
import { useCommits } from './use-commits'

interface CommitsViewProps {
  conversationId?: string
  projectUris?: string[]
  showProject?: boolean
  /** Copy for the empty state -- the reason a list is empty differs per scope. */
  emptyHint?: string
}

export function CommitsView({ conversationId, projectUris, showProject, emptyHint }: CommitsViewProps) {
  const [text, setText] = useState('')
  const [applied, setApplied] = useState('')
  const params: CommitListParams = { conversationId, projectUris, text: applied || undefined, limit: 200 }
  const { commits, total, loading } = useCommits(params)

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
        <Search className="size-3 text-muted-foreground shrink-0" />
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') setApplied(text.trim())
            if (e.key === 'Escape') {
              setText('')
              setApplied('')
            }
          }}
          placeholder="Search messages and touched paths, then Enter"
          className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
        />
        <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0">
          {commits.length}
          {total > commits.length ? ` / ${total}` : ''}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
        {loading && <div className="text-[11px] text-muted-foreground px-1 py-2">Loading commits...</div>}
        {!loading && commits.length === 0 && (
          <div className="px-1 py-6 text-center space-y-1">
            <GitCommitHorizontal className="size-5 mx-auto text-muted-foreground/40" />
            <div className="text-[11px] text-muted-foreground">
              {applied ? `Nothing matches "${applied}".` : (emptyHint ?? 'No commits recorded yet.')}
            </div>
          </div>
        )}
        {commits.map(commit => (
          <CommitRowItem key={`${commit.repoUri}:${commit.hash}`} commit={commit} showProject={showProject} />
        ))}
      </div>
    </div>
  )
}
