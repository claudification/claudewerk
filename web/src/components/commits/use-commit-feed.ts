/**
 * The global feed: cursor-paginated chronological commits plus the decorations
 * the group headers need. Live commits prepend (newest-first is the sort, so a
 * fresh one always belongs at the top).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommitRow } from '@/lib/commits'
import { appendShareParam } from '@/lib/share-mode'
import { type FeedFilters, feedQueryString, matchesFeedFilters } from './feed-filters'

export type { FeedFilters }

export interface ConversationDecoration {
  id: string
  name: string | null
  title?: string
  status: string
  project: string | null
}

export interface ProjectDecoration {
  uri: string
  label: string
}

interface FeedPage {
  commits: CommitRow[]
  conversations: ConversationDecoration[]
  projects: ProjectDecoration[]
  cursor: string | null
  hasMore: boolean
}

async function fetchPage(filters: FeedFilters, cursor: string | null): Promise<FeedPage | null> {
  try {
    const res = await fetch(appendShareParam(feedQueryString(filters, cursor)))
    if (!res.ok) return null
    return (await res.json()) as FeedPage
  } catch {
    // A REQUEST THAT THROWS IS A PAGE THAT DID NOT ARRIVE, same as a 500.
    // Offline, broker down, a body that is not JSON -- without this the rejection
    // escapes `void fetchPage(...)`, `loading` never clears, and the surface says
    // "Loading..." for the rest of the session. A feed stuck loading forever is
    // indistinguishable from a slow one, which is the version you cannot debug.
    return null
  }
}

export interface CommitFeed {
  commits: CommitRow[]
  conversations: Map<string, ConversationDecoration>
  projects: Map<string, ProjectDecoration>
  loading: boolean
  hasMore: boolean
  loadMore: () => void
  /**
   * Throw away the pages and re-read from the top. Resolves FALSE when the read
   * did not land.
   *
   * The live prepend keeps this feed current while the socket is up; it says
   * nothing about the commits that landed while it was down. Re-reading the first
   * page is the only thing that closes that hole, and THE WALL's revive seam is
   * what calls it. Manual refresh buttons can use it too.
   */
  reload: () => Promise<boolean>
}

/**
 * @param autoLoad  read the first page on mount and on every filter change.
 *   THE WALL passes `false`: its revive seam owns every read of this feed, and
 *   two owners means two requests for the same page every time the wall opens.
 *   Its filters are a module constant, so there is no filter change to miss.
 */
export function useCommitFeed(filters: FeedFilters, autoLoad = true): CommitFeed {
  const [commits, setCommits] = useState<CommitRow[]>([])
  const [conversations, setConversations] = useState(new Map<string, ConversationDecoration>())
  const [projects, setProjects] = useState(new Map<string, ProjectDecoration>())
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const cursor = useRef<string | null>(null)
  const key = JSON.stringify(filters)

  const absorb = useCallback((page: FeedPage, append: boolean) => {
    setCommits(prev => (append ? [...prev, ...page.commits] : page.commits))
    setConversations(prev => {
      const next = append ? new Map(prev) : new Map<string, ConversationDecoration>()
      for (const c of page.conversations) next.set(c.id, c)
      return next
    })
    setProjects(prev => {
      const next = append ? new Map(prev) : new Map<string, ProjectDecoration>()
      for (const p of page.projects) next.set(p.uri, p)
      return next
    })
    cursor.current = page.cursor
    setHasMore(page.hasMore)
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!autoLoad) return
    let cancelled = false
    setLoading(true)
    cursor.current = null
    void fetchPage(JSON.parse(key) as FeedFilters, null).then(page => {
      if (cancelled) return
      if (page) absorb(page, false)
      else setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [key, absorb, autoLoad])

  const reload = useCallback(async () => {
    cursor.current = null
    const page = await fetchPage(JSON.parse(key) as FeedFilters, null)
    // A failed re-read leaves the rows that ARE on screen alone. Blanking a river
    // because the broker blinked is worse than a river with a hole in it.
    if (!page) {
      setLoading(false)
      return false
    }
    absorb(page, false)
    return true
  }, [key, absorb])

  const loadMore = useCallback(() => {
    if (!cursor.current) return
    void fetchPage(JSON.parse(key) as FeedFilters, cursor.current).then(page => {
      if (page) absorb(page, true)
    })
  }, [key, absorb])

  // Live prepend. Newest-first is the sort, so a fresh commit always belongs at
  // the head -- when it matches the active filters (see feed-filters.ts).
  useEffect(() => {
    const parsed = JSON.parse(key) as FeedFilters
    const onRecorded = (event: Event) => {
      const commit = (event as CustomEvent<{ commit?: CommitRow }>).detail?.commit
      if (!commit || !matchesFeedFilters(commit, parsed)) return
      setCommits(prev => (prev.some(c => c.hash === commit.hash) ? prev : [commit, ...prev]))
    }
    window.addEventListener('rclaude-commit-recorded', onRecorded)
    return () => window.removeEventListener('rclaude-commit-recorded', onRecorded)
  }, [key])

  return { commits, conversations, projects, loading, hasMore, loadMore, reload }
}
