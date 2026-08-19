/**
 * One commit line in the browser. Compact by design -- the run header already
 * says which project and conversation this belongs to, so the row only carries
 * what distinguishes it from its neighbours. Clicking opens the full detail.
 */

import { openCommitDetail } from '@/hooks/use-commit-modals'
import { type CommitRow, commitAge } from '@/lib/commits'
import { haptic } from '@/lib/utils'
import { CommitSummaryLine } from './commit-summary-line'

export function CommitFeedRow({ commit }: { commit: CommitRow }) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic('tick')
        openCommitDetail(commit.hash)
      }}
      className="w-full text-left px-2 py-1 hover:bg-accent/5 transition-colors"
    >
      <CommitSummaryLine
        commit={commit}
        trailing={
          <>
            <span className="text-[10px] font-mono text-fg-dim shrink-0 hidden sm:inline">{commit.branch}</span>
            <span className="text-[10px] text-fg-muted shrink-0">{commitAge(commit.committedAt)}</span>
          </>
        }
      />
    </button>
  )
}
