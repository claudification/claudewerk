/**
 * Live-commit filter matching. This decides whether a commit arriving over the
 * socket is spliced into an already-filtered list WITHOUT asking the server --
 * so a wrong answer silently shows a row that does not belong to the filter the
 * view claims to be showing.
 */

import { describe, expect, it } from 'vitest'
import type { CommitRow } from '@/lib/commits'
import { feedQueryString, matchesFeedFilters } from './feed-filters'

const REPO = 'claude://default/proj'
const WORKTREE = 'claude://default/proj/.claude/worktrees/x'

function c(over: Partial<CommitRow> = {}): CommitRow {
  return { repoUri: REPO, cwdUri: WORKTREE, origin: 'agent', ...over } as CommitRow
}

describe('matchesFeedFilters', () => {
  it('accepts anything when no filter is set', () => {
    expect(matchesFeedFilters(c(), {})).toBe(true)
  })

  it('REFUSES everything while a text search is active', () => {
    // Matching is FTS on the server; we cannot reproduce it here, and guessing
    // would lie about what the search returned.
    expect(matchesFeedFilters(c(), { text: 'auth' })).toBe(false)
    expect(matchesFeedFilters(c({ subject: 'fix auth' } as Partial<CommitRow>), { text: 'auth' })).toBe(false)
  })

  it('filters on origin', () => {
    expect(matchesFeedFilters(c({ origin: 'agent' }), { origin: 'agent' })).toBe(true)
    expect(matchesFeedFilters(c({ origin: 'human' }), { origin: 'agent' })).toBe(false)
  })

  it('matches a project on EITHER the repo root or the worktree URI', () => {
    expect(matchesFeedFilters(c(), { project: REPO })).toBe(true)
    expect(matchesFeedFilters(c(), { project: WORKTREE })).toBe(true)
    expect(matchesFeedFilters(c(), { project: 'claude://default/elsewhere' })).toBe(false)
  })

  it('requires every active filter to pass', () => {
    expect(matchesFeedFilters(c({ origin: 'human' }), { project: REPO, origin: 'agent' })).toBe(false)
    expect(matchesFeedFilters(c({ origin: 'agent' }), { project: REPO, origin: 'agent' })).toBe(true)
  })
})

describe('feedQueryString', () => {
  it('is a bare path when nothing is filtered', () => {
    expect(feedQueryString({}, null)).toBe('/api/commits/feed')
  })

  it('carries every filter and the cursor', () => {
    const url = feedQueryString({ text: 'a b', origin: 'human', project: REPO }, '123:9')
    expect(url).toContain('q=a+b')
    expect(url).toContain('origin=human')
    expect(url).toContain('cursor=123%3A9')
    expect(url).toContain(encodeURIComponent(REPO))
  })
})
