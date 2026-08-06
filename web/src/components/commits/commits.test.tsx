/**
 * Commit ledger UI -- what a row shows, what expanding reveals, and the two
 * behaviours that are easy to get silently wrong: a live commit arriving for a
 * DIFFERENT scope must not appear, and a truncated file list must say so.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommitRow } from '@/lib/commits'
import { ProjectCommitsSection } from '../conversation-detail/project-commits-section'
import { CommitRowItem } from './commit-row'

const PROJECT = 'claude://default/Users/x/proj'

function commit(over: Partial<CommitRow> = {}): CommitRow {
  return {
    id: 1,
    hash: 'a'.repeat(40),
    shortHash: 'aaaaaaaa',
    parentHashes: 'b'.repeat(40),
    repoUri: PROJECT,
    cwdUri: `${PROJECT}/.claude/worktrees/feature`,
    repoName: 'proj',
    branch: 'feature',
    isWorktree: true,
    conversationId: 'conv-1',
    conversationName: 'blazing-pretzel',
    sentinel: 'default',
    profile: null,
    host: 'studio',
    container: '',
    osUser: 'jonas',
    authorName: 'Jonas Frost',
    authorEmail: 'j@duplo.org',
    subject: 'feat(ledger): record commits',
    body: 'the long why',
    files: [{ status: 'M', path: 'src/broker/auth.ts' }],
    fileCount: 1,
    filesTruncated: false,
    insertions: 12,
    deletions: 3,
    kind: 'normal',
    ccType: 'feat',
    ccScope: 'ledger',
    ccBreaking: false,
    origin: 'agent',
    supersededBy: null,
    committedAt: Date.now() - 60_000,
    ingestedAt: Date.now(),
    ...over,
  }
}

function mockFetch(commits: CommitRow[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/transcript')) {
      return new Response(JSON.stringify({ conversationId: 'conv-1', anchor: null }), { status: 200 })
    }
    return new Response(JSON.stringify({ commits, total: commits.length }), { status: 200 })
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch([]))
})

afterEach(cleanup)

describe('CommitRowItem', () => {
  it('shows the identity a commit is judged on without expanding', () => {
    render(<CommitRowItem commit={commit()} />)
    expect(screen.getByText('aaaaaaaa')).toBeTruthy()
    expect(screen.getByText('feat(ledger): record commits')).toBeTruthy()
    expect(screen.getByText('agent')).toBeTruthy()
    expect(screen.getByText('studio')).toBeTruthy()
    expect(screen.getByText('+12')).toBeTruthy()
  })

  it('reveals the file list and the conversation link on expand', async () => {
    render(<CommitRowItem commit={commit()} />)
    fireEvent.click(screen.getByText('feat(ledger): record commits'))
    expect(screen.getByText('src/broker/auth.ts')).toBeTruthy()
    expect(screen.getByText(/Open the conversation that made this/)).toBeTruthy()
  })

  it('says so when the stored file list was truncated', async () => {
    render(<CommitRowItem commit={commit({ filesTruncated: true, fileCount: 900 })} />)
    fireEvent.click(screen.getByText('feat(ledger): record commits'))
    expect(screen.getByText(/showing 500 of 900 files/)).toBeTruthy()
  })

  it('offers no conversation link for a human terminal commit', async () => {
    render(<CommitRowItem commit={commit({ conversationId: null, origin: 'human' })} />)
    fireEvent.click(screen.getByText('feat(ledger): record commits'))
    expect(screen.queryByText(/Open the conversation/)).toBeNull()
  })
})

describe('ProjectCommitsSection', () => {
  it('renders nothing when the project has no commits', async () => {
    const { container } = render(<ProjectCommitsSection projectUri={PROJECT} />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('lists the project commits with a count', async () => {
    vi.stubGlobal('fetch', mockFetch([commit()]))
    render(<ProjectCommitsSection projectUri={PROJECT} />)
    expect(await screen.findByText('Recent commits (1)')).toBeTruthy()
  })

  it('ignores a live commit recorded for a different project', async () => {
    vi.stubGlobal('fetch', mockFetch([commit()]))
    render(<ProjectCommitsSection projectUri={PROJECT} />)
    await screen.findByText('Recent commits (1)')

    const foreign = commit({
      hash: 'f'.repeat(40),
      repoUri: 'claude://default/elsewhere',
      cwdUri: 'claude://default/elsewhere',
    })
    window.dispatchEvent(new CustomEvent('rclaude-commit-recorded', { detail: { commit: foreign } }))
    await waitFor(() => expect(screen.getByText('Recent commits (1)')).toBeTruthy())
  })

  it('appends a live commit recorded for this project', async () => {
    vi.stubGlobal('fetch', mockFetch([commit()]))
    render(<ProjectCommitsSection projectUri={PROJECT} />)
    await screen.findByText('Recent commits (1)')

    const fresh = commit({ hash: 'c'.repeat(40), shortHash: 'cccccccc', subject: 'fix: a live one' })
    window.dispatchEvent(new CustomEvent('rclaude-commit-recorded', { detail: { commit: fresh } }))
    expect(await screen.findByText('Recent commits (2)')).toBeTruthy()
    expect(screen.getByText('fix: a live one')).toBeTruthy()
  })
})
