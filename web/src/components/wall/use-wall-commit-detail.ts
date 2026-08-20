/**
 * The in-wall commit detail's read, driven by THE REVIVE SEAM rather than by its
 * own mount effect (epic-the-wall-ii RULE 7).
 *
 * `useCommitDetail` fetches on mount and never again: correct for a modal you
 * open, read and close, wrong for a panel that can sit open on a second monitor
 * through a broker restart. So the fetch here is a `WallReload` handed to
 * `useWallRevive`, which owns when it fires -- once per connection, again on
 * every reconnect -- and answers with FRESHNESS.
 *
 * A READ THAT DID NOT LAND KEEPS THE PANEL. `fetchCommitDetail` returns `null`
 * for a dead broker as opposed to a clean 404, and that distinction is the
 * point: erasing an open commit because the socket dropped, and calling it "no
 * such commit", is a worse lie than a panel that says STALE.
 *
 * SUBJECT vs CONNECTION. The seam re-pulls per CONNECTION. Clicking a second
 * river row while the first is open is a new subject on the same connection, so
 * the hash effect forces its own pull -- skipping the mount, which the seam has
 * already covered.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { type CommitDetail, fetchCommitDetail } from '@/components/commits/use-commit-detail'
import { useConversationsStore } from '@/hooks/use-conversations'
import { pullFeed, type WallFeedId } from '@/lib/wall/revive-store'
import { useWallRevive } from '@/lib/wall/use-wall-revive'

/** Not exported: nothing outside this file drives the feed. The revive suite
 *  reads it by name, which is the same string one indirection cheaper. */
const COMMIT_DETAIL_FEED: WallFeedId = 'commit-detail'

export interface WallCommitDetail {
  detail: CommitDetail
  /** It last landed on an EARLIER connection than the one we are on now. */
  stale: boolean
}

export function useWallCommitDetail(hash: string): WallCommitDetail {
  const [detail, setDetail] = useState<CommitDetail>({ status: 'loading' })

  const reload = useCallback(async () => {
    const next = await fetchCommitDetail(hash)
    if (!next) return false
    setDetail(next)
    return true
  }, [hash])

  const freshness = useWallRevive(COMMIT_DETAIL_FEED, reload)

  // Seeded with the first hash, so the mount falls straight through -- the seam
  // has already issued that pull and a second one here would double every open.
  const shown = useRef(hash)
  useEffect(() => {
    if (shown.current === hash) return
    shown.current = hash
    setDetail({ status: 'loading' })
    void pullFeed(COMMIT_DETAIL_FEED, useConversationsStore.getState().connectSeq, true)
  }, [hash])

  return { detail, stale: freshness.loaded && freshness.stale }
}
