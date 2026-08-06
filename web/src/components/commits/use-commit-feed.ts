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
  const res = await fetch(appendShareParam(feedQueryString(filters, cursor)))
  if (!res.ok) return null
  return (await res.json()) as FeedPage
}

export interface CommitFeed {
  commits: CommitRow[]
  conversations: Map<string, ConversationDecoration>
  projects: Map<string, ProjectDecoration>
  loading: boolean
  hasMore: boolean
  loadMore: () => void
}

export function useCommitFeed(filters: FeedFilters): CommitFeed {
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

  return { commits, conversations, projects, loading, hasMore, loadMore }
}
