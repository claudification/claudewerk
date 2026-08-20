/**
 * The commit detail MODAL's body: fetch by hash, then render.
 *
 * The rendering itself is `commit-detail-view.tsx`, because THE WALL shows the
 * same layout from a commit its own revive seam already pulled. This file is the
 * fetching half and nothing else.
 */

import { CommitDetailView } from './commit-detail-view'
import { useCommitDetail } from './use-commit-detail'

export function CommitDetailBody({ hash }: { hash: string }) {
  const detail = useCommitDetail(hash)

  if (detail.status === 'missing')
    return <div className="text-[11px] text-muted-foreground">No commit matches {hash}.</div>
  if (detail.status === 'loading') return <div className="text-[11px] text-muted-foreground">Loading...</div>

  return <CommitDetailView commit={detail.commit} />
}
