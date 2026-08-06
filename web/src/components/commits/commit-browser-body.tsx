/**
 * The global commit browser body: a chronological feed, decluttered by
 * run-length group headers. See group-run-length.ts -- nothing is reordered.
 */

import { GitCommitHorizontal } from 'lucide-react'
import { useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { haptic } from '@/lib/utils'
import { CommitFeedRow } from './commit-feed-row'
import { CommitRunHeader } from './commit-run-header'
import { CommitSearchBar } from './commit-search-bar'
import { groupIntoRuns } from './group-run-length'
import { type FeedFilters, useCommitFeed } from './use-commit-feed'
import { useFullCommitStream } from './use-commit-subscription'

const ORIGINS: Array<{ id: FeedFilters['origin']; label: string }> = [
  { id: undefined, label: 'all' },
  { id: 'agent', label: 'agent' },
  { id: 'human', label: 'human' },
]

export function CommitBrowserBody({ projectFilter }: { projectFilter?: string }) {
  const [applied, setApplied] = useState('')
  const [origin, setOrigin] = useState<FeedFilters['origin']>(undefined)
  // Full rows only while this surface is mounted; the socket drops back to
  // counts on unmount.
  useFullCommitStream()

  const feed = useCommitFeed({ text: applied || undefined, origin, project: projectFilter })
  const runs = groupIntoRuns(feed.commits)

  return (
    <div className="flex flex-col h-full min-h-0">
      <CommitSearchBar
        onApply={setApplied}
        trailing={ORIGINS.map(o => (
          <button
            key={o.label}
            type="button"
            onClick={() => {
              haptic('tick')
              setOrigin(o.id)
            }}
            className={
              origin === o.id
                ? 'text-[10px] px-1.5 py-0.5 bg-accent/20 text-accent'
                : 'text-[10px] px-1.5 py-0.5 text-muted-foreground hover:text-foreground'
            }
          >
            {o.label}
          </button>
        ))}
      />

      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
        {feed.loading && <div className="text-[11px] text-muted-foreground py-3">Loading commits...</div>}
        {!feed.loading && runs.length === 0 && (
          <div className="py-10 text-center space-y-1">
            <GitCommitHorizontal className="size-5 mx-auto text-muted-foreground/40" />
            <div className="text-[11px] text-muted-foreground">
              {applied ? `Nothing matches "${applied}".` : 'No commits recorded yet.'}
            </div>
          </div>
        )}

        {runs.map(run => (
          <div key={run.key}>
            <CommitRunHeader
              projectUri={run.projectUri}
              conversationId={run.conversationId}
              project={feed.projects.get(run.projectUri)}
              conversation={run.conversationId ? feed.conversations.get(run.conversationId) : undefined}
              continuesProject={run.continuesProject}
              onOpenProject={uri => useConversationsStore.getState().selectProject(uri)}
            />
            <div className="space-y-0.5 pl-4">
              {run.commits.map(commit => (
                <CommitFeedRow key={`${commit.repoUri}:${commit.hash}`} commit={commit} />
              ))}
            </div>
          </div>
        ))}

        {feed.hasMore && (
          <button
            type="button"
            onClick={() => {
              haptic('tap')
              feed.loadMore()
            }}
            className="mt-3 w-full text-[11px] text-muted-foreground hover:text-foreground py-2 border border-border transition-colors"
          >
            Load older commits
          </button>
        )}
      </div>
    </div>
  )
}
