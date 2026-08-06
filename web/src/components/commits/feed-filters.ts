/**
 * Feed filter shape + the client-side match used when a LIVE commit arrives.
 *
 * Pure and separate so it can be tested directly: a live commit is spliced into
 * a filtered list without asking the server, and getting this wrong means the
 * view quietly shows a row that does not belong to the filter it claims.
 */

import type { CommitRow } from '@/lib/commits'

export interface FeedFilters {
  text?: string
  origin?: 'agent' | 'human'
  project?: string
}

/** Does a freshly-recorded commit belong in a feed with these filters?
 *
 *  A TEXT filter always answers NO: matching is FTS on the server, we cannot
 *  reproduce it here, and showing a non-matching row would lie about what the
 *  search returned. The caller re-queries instead. */
export function matchesFeedFilters(commit: CommitRow, filters: FeedFilters): boolean {
  if (filters.text) return false
  if (filters.origin && commit.origin !== filters.origin) return false
  if (filters.project && filters.project !== commit.repoUri && filters.project !== commit.cwdUri) return false
  return true
}

/** The feed query string. Kept next to the filters so a new filter is one edit. */
export function feedQueryString(filters: FeedFilters, cursor: string | null): string {
  const params = new URLSearchParams()
  if (filters.text) params.set('q', filters.text)
  if (filters.origin) params.set('origin', filters.origin)
  if (filters.project) params.set('project', filters.project)
  if (cursor) params.set('cursor', cursor)
  const query = params.toString()
  return query ? `/api/commits/feed?${query}` : '/api/commits/feed'
}
