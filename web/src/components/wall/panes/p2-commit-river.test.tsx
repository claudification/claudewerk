/**
 * P2: the four claims the card makes about the pane.
 *
 *  - the row format is the specified one, with the project NAMED
 *  - rows stream in live, with no second fetch
 *  - a click lands on the commit detail, and the copy button hands over the SHA
 *    rather than the line on screen
 *  - the filter is the shared one: declared axes bite, undeclared axes leave the
 *    pane FULL, `{matched}/{total}` rides the WallPane count slot, and the
 *    project chip goes through the store's exported action
 */

import type { CommitRow } from '@shared/commit-ledger'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCommitModalStore } from '@/hooks/use-commit-modals'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { useWallDetail } from '../wall-detail-store'
import CommitRiverPane from './p2-commit-river'

const NOW = new Date(2026, 7, 20, 14, 0, 0).getTime()
const MIN = 60_000
const ALPHA = 'claude://default/Users/x/alpha'
const BETA = 'claude://default/Users/x/beta'

function commit(over: Partial<CommitRow> = {}): CommitRow {
  return {
    id: 1,
    hash: 'a'.repeat(40),
    shortHash: 'aaaaaaa',
    parentHashes: 'b'.repeat(40),
    repoUri: ALPHA,
    cwdUri: `${ALPHA}/.claude/worktrees/feature`,
    repoName: 'alpha',
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
    subject: 'feat(wall): the river',
    body: '',
    files: [],
    fileCount: 1,
    filesTruncated: false,
    insertions: 12,
    deletions: 3,
    kind: 'normal',
    ccType: 'feat',
    ccScope: 'wall',
    ccBreaking: false,
    origin: 'agent',
    supersededBy: null,
    committedAt: NOW - 10 * MIN,
    ingestedAt: NOW,
    ...over,
  }
}

let fetchMock: ReturnType<typeof vi.fn>

function servePage(commits: CommitRow[], hasMore = false) {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ commits, conversations: [], projects: [], cursor: null, hasMore }), {
        status: 200,
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
}

async function mount(commits: CommitRow[], hasMore = false) {
  servePage(commits, hasMore)
  const view = render(<CommitRiverPane />)
  if (commits.length) await waitFor(() => expect(document.querySelector('.wall-river-row')).toBeTruthy())
  return view
}

const rows = () => [...document.querySelectorAll('.wall-river-row')]
const separators = () => [...document.querySelectorAll('.wall-river-sep span')].map(el => el.textContent)
const countSlot = () => document.querySelector('.wall-pane-count')?.textContent ?? ''

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  useWallFilterStore.getState().clear()
  useCommitModalStore.setState({ hash: null })
  useWallDetail.setState({ hash: null })
  useModalManagerStore.setState({ records: {} })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('P2 commit river', () => {
  it('renders the specified row: delta-t, sha, NAMED project, subject, diffstat', async () => {
    await mount([commit()])
    const row = rows()[0]
    expect(row?.querySelector('.wall-river-t')?.textContent).toBe('10m')
    expect(row?.querySelector('.wall-river-sha')?.textContent).toBe('aaaaaaa')
    // Named, in words -- not a bare coloured dot you have to learn.
    expect(row?.querySelector('[data-project]')?.getAttribute('data-project')).toBe('alpha')
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(row?.querySelector('.wall-river-msg')?.textContent).toBe('feat(wall): the river')
    expect(row?.querySelector('.wall-river-stat')?.textContent).toContain('+12')
    expect(row?.querySelector('.wall-river-stat')?.textContent).toContain('-3')
  })

  it('buckets by hour band, newest band first', async () => {
    await mount([
      commit({ hash: '1'.repeat(40), shortHash: '1111111', committedAt: NOW - 10 * MIN }),
      commit({ hash: '2'.repeat(40), shortHash: '2222222', committedAt: new Date(2026, 7, 20, 9).getTime() }),
      commit({ hash: '3'.repeat(40), shortHash: '3333333', committedAt: new Date(2026, 7, 19, 9).getTime() }),
      commit({ hash: '4'.repeat(40), shortHash: '4444444', committedAt: new Date(2026, 7, 11, 9).getTime() }),
    ])
    expect(separators()).toEqual(['LAST HOUR', 'EARLIER TODAY', 'YESTERDAY', 'OLDER'])
  })

  it('streams a live commit in without a second fetch', async () => {
    await mount([commit()])
    expect(rows()).toHaveLength(1)
    const before = fetchMock.mock.calls.length

    act(() => {
      window.dispatchEvent(
        new CustomEvent('rclaude-commit-recorded', {
          detail: { commit: commit({ hash: 'c'.repeat(40), shortHash: 'ccccccc', subject: 'fix(wall): landed live' }) },
        }),
      )
    })

    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(screen.getByText('fix(wall): landed live')).toBeTruthy()
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('copies the FULL sha, not the seven characters on screen', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await mount([commit()])

    fireEvent.click(screen.getByLabelText('Copy the sha aaaaaaa'))
    expect(writeText).toHaveBeenCalledWith('a'.repeat(40))
    // ...and copying must not also open the detail underneath it.
    expect(useWallDetail.getState().hash).toBeNull()
  })

  /**
   * `wall-commit-detail-in-wall` moved the destination: the row asks the ONE
   * transport for the IN-WALL target, so the commit opens on the wall's own
   * surface and the main window's commit modal stays shut. The panel itself is
   * `wall-detail.test.tsx`; what P2 owns is which target the row asks for.
   */
  it('opens the commit detail IN THE WALL for the clicked row, not in the main window', async () => {
    await mount([commit()])
    fireEvent.click(rows()[0] as Element)

    expect(useWallDetail.getState().hash).toBe('a'.repeat(40))
    expect(useCommitModalStore.getState().hash).toBeNull()
    expect(useModalManagerStore.getState().records['commit-detail']).toBeUndefined()
  })

  it('renders {matched}/{total} in the pane count slot and filters on a declared axis', async () => {
    await mount([commit(), commit({ hash: 'd'.repeat(40), shortHash: 'ddddddd', repoUri: BETA, repoName: 'beta' })])
    expect(countSlot()).toBe('2/2')

    act(() => {
      useWallFilterStore.getState().setRaw('@beta')
    })
    expect(countSlot()).toBe('1/2')
    expect(rows()).toHaveLength(1)
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('stays FULL under an axis it never declared', async () => {
    await mount([commit()])
    // `%80` is context pressure and `!!` is a pulse band -- a commit has neither
    // facet, and the pane declares neither axis, so it must drop nobody.
    act(() => {
      useWallFilterStore.getState().setRaw('%80 !!')
    })
    // Guard against a vacuous pass: the query really did parse into two
    // constraints, they are simply not ones this pane declared.
    expect(useWallFilterStore.getState().query.minContextPct).toBe(80)
    expect(useWallFilterStore.getState().query.bands).not.toBeNull()
    expect(countSlot()).toBe('1/1')
    expect(rows()).toHaveLength(1)
  })

  it('scopes the wall from the project chip THROUGH the store action', async () => {
    await mount([commit()])
    fireEvent.click(document.querySelector('[data-project]') as Element)
    expect(useWallFilterStore.getState().raw).toBe('@alpha')

    // The same action toggles it back off -- proof this is the store's chip
    // handler and not a local set-the-filter of our own.
    fireEvent.click(document.querySelector('[data-project]') as Element)
    expect(useWallFilterStore.getState().raw).toBe('')
    // And the chip click never opened the commit detail on the way past.
    expect(useWallDetail.getState().hash).toBeNull()
  })

  it('distinguishes an empty ledger from an empty filter', async () => {
    await mount([])
    await waitFor(() => expect(screen.getByText('no commit in the ledger')).toBeTruthy())

    cleanup()
    await mount([commit()])
    act(() => {
      useWallFilterStore.getState().setRaw('@nowhere')
    })
    expect(screen.getByText('no commit matches the filter')).toBeTruthy()
  })

  it('says the ledger goes back further instead of ending in silence', async () => {
    await mount([commit()], true)
    expect(screen.getByText(/open the commit browser/)).toBeTruthy()
  })
})
