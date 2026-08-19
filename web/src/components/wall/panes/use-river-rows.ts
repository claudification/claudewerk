/**
 * P2's feed: the commit ledger, live, as river rows.
 *
 * NO NEW ROUTE AND NO NEW SOCKET. `useCommitFeed` is the same cursor-paginated
 * `/api/commits/feed` read the commit browser uses, and it already prepends a
 * live commit from the `rclaude-commit-recorded` event the websocket handler
 * dispatches -- so a commit landing while the wall is open appears without a
 * refetch. `useFullCommitStream` is what makes that event carry whole rows
 * instead of counts, and it is reference-counted, so opening the wall next to
 * the commit browser does not downgrade the socket under it.
 *
 * THE FEED IS ASKED FOR EVERYTHING. Filtering happens once, in the pane, through
 * `useWallFilter` -- a pre-filtered feed would fork the predicate and make the
 * wall's own query box disagree with `{matched}/{total}`.
 */

import { useMemo } from 'react'
import { type FeedFilters, useCommitFeed } from '@/components/commits/use-commit-feed'
import { useFullCommitStream } from '@/components/commits/use-commit-subscription'
import { commitRiverRows, type RiverRow } from '@/lib/wall/commit-river'
import { useProjectLook } from '../use-project-look'
import { useWallClock } from '../use-wall-clock'

/** The whole ledger. A module constant so the feed's cache key never churns. */
const EVERYTHING: FeedFilters = {}

/**
 * THIRTY SECONDS.
 *
 * Every age on this pane is a delta-t rounded to whole minutes, so a per-second
 * tick would rebuild and re-filter the list sixty times a minute to move a digit
 * twice. The clock exists at all because `~30m` typed in the wall's box has to
 * keep meaning thirty minutes as the wall sits there -- an age frozen at mount
 * would quietly stop dropping rows.
 */
const RIVER_TICK_MS = 30_000

export interface RiverFeed {
  rows: RiverRow[]
  loading: boolean
  /** The ledger holds commits older than the page on screen. */
  hasMore: boolean
}

export function useRiverRows(): RiverFeed {
  useFullCommitStream()
  const { commits, loading, hasMore } = useCommitFeed(EVERYTHING)
  const look = useProjectLook()
  const nowMs = useWallClock(RIVER_TICK_MS)

  const rows = useMemo(() => commitRiverRows(commits, look, nowMs), [commits, look, nowMs])
  return { rows, loading, hasMore }
}
