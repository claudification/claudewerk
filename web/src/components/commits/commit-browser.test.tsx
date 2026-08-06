/**
 * The browser surface: run headers with liveness, chronological order intact,
 * click-throughs to project and conversation (including an ENDED one), and the
 * commit detail view.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommitRow } from '@/lib/commits'
import { CommitBrowserBody } from './commit-browser-body'
import { CommitDetailBody } from './commit-detail-body'
import { CommitRunHeader } from './commit-run-header'

const A = 'claude://default/proj-a'
const B = 'claude://default/proj-b'

const selectConversation = vi.fn()
const selectProject = vi.fn()
vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: { getState: () => ({ selectConversation, selectProject }) },
  wsSend: () => true,
}))

function c(over: Partial<CommitRow> = {}): CommitRow {
  return {
    id: 1,
    hash: 'a'.repeat(40),
    shortHash: 'aaaaaaaa',
    parentHashes: 'b'.repeat(40),
    repoUri: A,
    cwdUri: A,
    repoName: 'proj-a',
    branch: 'main',
    isWorktree: false,
    conversationId: 'conv-1',
    conversationName: 'blazing-pretzel',
    sentinel: 'default',
    profile: null,
    host: 'studio',
    container: '',
    osUser: 'jonas',
    authorName: 'Jonas Frost',
    authorEmail: 'j@duplo.org',
    subject: 'feat: one',
    body: 'why it happened',
    files: [{ status: 'M', path: 'src/a.ts' }],
    fileCount: 1,
    filesTruncated: false,
    insertions: 3,
    deletions: 1,
    kind: 'normal',
    ccType: 'feat',
    ccScope: null,
    ccBreaking: false,
    origin: 'agent',
    supersededBy: null,
    committedAt: Date.now() - 60_000,
    ingestedAt: Date.now(),
    ...over,
  }
}

function mockFeed(commits: CommitRow[], conversations: Array<{ id: string; status: string; name?: string }> = []) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/transcript')) {
      return new Response(JSON.stringify({ conversationId: 'conv-1', anchor: null }), { status: 200 })
    }
    if (url.includes('/api/commits/feed')) {
      return new Response(
        JSON.stringify({
          commits,
          conversations: conversations.map(x => ({ name: null, project: null, ...x })),
          projects: [
            { uri: A, label: 'proj-a' },
            { uri: B, label: 'proj-b' },
          ],
          cursor: null,
          hasMore: false,
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ commit: commits[0] }), { status: 200 })
  })
}

beforeEach(() => {
  selectConversation.mockClear()
  selectProject.mockClear()
  vi.stubGlobal('fetch', mockFeed([]))
})
afterEach(cleanup)

describe('CommitRunHeader', () => {
  const base = {
    projectUri: A,
    conversationId: 'conv-1',
    project: { uri: A, label: 'proj-a' },
    continuesProject: false,
    onOpenProject: vi.fn(),
  }

  it('shows the conversation liveness', () => {
    render(
      <CommitRunHeader
        {...base}
        conversation={{ id: 'conv-1', name: 'blazing-pretzel', status: 'active', project: A }}
      />,
    )
    expect(screen.getByText('active')).toBeTruthy()
    expect(screen.getByText('blazing-pretzel')).toBeTruthy()
  })

  it('reports a conversation the ledger outlived as gone', () => {
    render(<CommitRunHeader {...base} conversation={undefined} />)
    expect(screen.getByText('gone')).toBeTruthy()
  })

  it('opens an ENDED conversation -- liveness gates the pill, not access', () => {
    render(
      <CommitRunHeader {...base} conversation={{ id: 'conv-1', name: 'old-one', status: 'ended', project: A }} />,
    )
    fireEvent.click(screen.getByText('old-one'))
    expect(selectConversation).toHaveBeenCalledWith('conv-1', 'commit-browser')
  })

  it('clicking the project calls through', () => {
    const onOpenProject = vi.fn()
    render(<CommitRunHeader {...base} onOpenProject={onOpenProject} conversation={undefined} />)
    fireEvent.click(screen.getByText('proj-a'))
    expect(onOpenProject).toHaveBeenCalledWith(A)
  })

  it('labels a commit with no conversation as a terminal commit', () => {
    render(<CommitRunHeader {...base} conversationId={null} conversation={undefined} />)
    expect(screen.getByText('terminal (human)')).toBeTruthy()
  })
})

describe('CommitBrowserBody', () => {
  it('renders a project header again further down the timeline', async () => {
    vi.stubGlobal(
      'fetch',
      mockFeed(
        [
          c({ hash: 'h1', shortHash: 'h1', subject: 'first', repoUri: A, conversationId: 'conv-1' }),
          c({ hash: 'h2', shortHash: 'h2', subject: 'second', repoUri: B, conversationId: 'conv-2' }),
          c({ hash: 'h3', shortHash: 'h3', subject: 'third', repoUri: A, conversationId: 'conv-3' }),
        ],
        [
          { id: 'conv-1', status: 'active' },
          { id: 'conv-2', status: 'idle' },
          { id: 'conv-3', status: 'ended' },
        ],
      ),
    )
    render(<CommitBrowserBody />)
    await screen.findByText('first')
    // proj-a heads TWO separate runs -- chronology preserved, not collapsed.
    expect(screen.getAllByText('proj-a')).toHaveLength(2)
    expect(screen.getAllByText('proj-b')).toHaveLength(1)
  })

  it('shows an empty state when the ledger has nothing', async () => {
    render(<CommitBrowserBody />)
    expect(await screen.findByText(/No commits recorded yet/)).toBeTruthy()
  })
})

describe('CommitDetailBody', () => {
  it('shows the message, the diffstat and where it ran', async () => {
    vi.stubGlobal('fetch', mockFeed([c()]))
    render(<CommitDetailBody hash={'a'.repeat(40)} />)
    expect(await screen.findByText('feat: one')).toBeTruthy()
    expect(screen.getByText('why it happened')).toBeTruthy()
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText('studio')).toBeTruthy()
    expect(screen.getByText('+3')).toBeTruthy()
  })

  it('says plainly when a terminal commit has no transcript', async () => {
    vi.stubGlobal('fetch', mockFeed([c({ conversationId: null, origin: 'human' })]))
    render(<CommitDetailBody hash={'a'.repeat(40)} />)
    expect(await screen.findByText(/no transcript to open/)).toBeTruthy()
  })

  it('reports a hash the ledger does not have', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    render(<CommitDetailBody hash="deadbeef" />)
    await waitFor(() => expect(screen.getByText(/No commit matches deadbeef/)).toBeTruthy())
  })
})
