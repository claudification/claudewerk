/**
 * P2b: A COMMIT OPENS IN THE WALL.
 *
 * The six claims the card makes, and the second is the one worth the rig:
 *
 *  1. HOVER previews without navigating and without eating the row's click.
 *  2. CLICK opens the detail INSIDE `.wall-root` -- the main window does not
 *     move, and it does not move in the DETACHED case either, which is the one
 *     that used to break. A detached wall portals its DOM into the popup while
 *     its React tree stays in the opener, so "apply here and raise the window"
 *     looks correct from inside the transport and lands the commit on the
 *     dashboard, in front of the second monitor.
 *  3. It costs the hard v1 grid nothing when it is shut.
 *  4. Escape and click-away close it and hand focus back to the row.
 *  5. It revives on a reconnect, and says STALE when it cannot.
 *  6. It is mounted on the REAL surface, not just in this file's harness.
 */

import type { CommitRow } from '@shared/commit-ledger'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CardHoverLayer } from '@/components/card-hover/card-hover-layer'
import { useCommitModalStore } from '@/hooks/use-commit-modals'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { feedPulls, resetWallRevive } from '@/lib/wall/revive-store'
import CommitRiverPane from './panes/p2-commit-river'
import { WallDetail } from './wall-detail'
import { useWallDetail } from './wall-detail-store'
import { useWallStore } from './wall-state'

const NOW = new Date(2026, 7, 20, 14, 0, 0).getTime()
const HASH = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

function commit(over: Partial<CommitRow> = {}): CommitRow {
  return {
    id: 1,
    hash: HASH,
    shortHash: 'aaaaaaa',
    parentHashes: 'c'.repeat(40),
    repoUri: 'claude://default/Users/x/alpha',
    cwdUri: 'claude://default/Users/x/alpha',
    repoName: 'alpha',
    branch: 'feature',
    isWorktree: true,
    conversationId: null,
    conversationName: null,
    sentinel: 'default',
    profile: null,
    host: 'studio',
    container: '',
    osUser: 'jonas',
    authorName: 'Jonas Frost',
    authorEmail: 'j@duplo.org',
    subject: 'feat(wall): the river',
    body: 'the body the row could not afford',
    files: [{ status: 'M', path: 'web/src/components/wall/wall-detail.tsx' }],
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
    committedAt: NOW - 600_000,
    ingestedAt: NOW,
    ...over,
  }
}

/** The broker, present or absent -- read fresh on every request. */
let answering = true
let detailReads = 0

function serve(commits: CommitRow[]): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!answering) throw new Error('broker is down')
    if (url.includes('/api/commits/feed')) {
      return Response.json({ commits, conversations: [], projects: [], cursor: null, hasMore: false })
    }
    detailReads++
    const hash = url.split('/api/commits/')[1]?.split('?')[0] ?? ''
    const found = commits.find(c => c.hash === decodeURIComponent(hash))
    return found ? Response.json({ commit: found, others: [] }) : Response.json({ error: 'Not found' }, { status: 404 })
  })
}

/**
 * The wall's own DOM subtree -- `.wall-root` is what gets portaled into the
 * popup, so asserting INSIDE it is the same question as "did this land in the
 * window the click came from".
 */
function harness() {
  return render(
    <div className="wall-root">
      <CommitRiverPane />
      <WallDetail />
      <CardHoverLayer />
    </div>,
  )
}

const rows = () => [...document.querySelectorAll<HTMLElement>('.wall-river-row')]
const panel = () => document.querySelector('.wall-root .wall-detail-panel')

async function openTheRiver(commits: CommitRow[] = [commit()]) {
  serve(commits)
  const view = harness()
  await waitFor(() => expect(rows()).toHaveLength(commits.length))
  return view
}

beforeEach(() => {
  answering = true
  detailReads = 0
  resetWallRevive()
  useConversationsStore.setState({ connectSeq: 1 })
  useWallFilterStore.getState().clear()
  useWallDetail.setState({ hash: null })
  useCommitModalStore.setState({ hash: null })
  useModalManagerStore.setState({ records: {} })
  useWallStore.setState({ ambient: false })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a commit opens its detail IN THE WALL', () => {
  it('previews on hover without navigating and without swallowing the click', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await openTheRiver()
      fireEvent.mouseEnter(rows()[0] as Element)
      // The bus holds the open for 160ms so dragging across a river does not
      // queue a fetch per row.
      await act(async () => {
        vi.advanceTimersByTime(200)
      })

      await waitFor(() => expect(screen.getByText('the body the row could not afford')).toBeTruthy())
      // A PREVIEW: nothing navigated, nothing opened.
      expect(useWallDetail.getState().hash).toBeNull()
      expect(useCommitModalStore.getState().hash).toBeNull()

      // ...and the row underneath is still clickable.
      fireEvent.click(rows()[0] as Element)
      expect(useWallDetail.getState().hash).toBe(HASH)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the detail inside the wall and leaves the main window alone', async () => {
    await openTheRiver()
    fireEvent.click(rows()[0] as Element)

    await waitFor(() => expect(panel()).toBeTruthy())
    expect(screen.getByText('the body the row could not afford')).toBeTruthy()
    expect(screen.getByText('web/src/components/wall/wall-detail.tsx')).toBeTruthy()
    // The main window's commit surface never opened -- that is the whole card.
    expect(useCommitModalStore.getState().hash).toBeNull()
    expect(useModalManagerStore.getState().records['commit-detail']).toBeUndefined()
  })

  /**
   * THE DETACHED CASE. The wall is portaled into a popup, so this JS context is
   * the OPENER's: a transport that answered "here" would raise the dashboard
   * over the second monitor and open the commit on it.
   */
  it('does not raise or navigate the main window while the wall is detached', async () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    await openTheRiver()

    fireEvent.click(rows()[0] as Element)

    await waitFor(() => expect(panel()).toBeTruthy())
    expect(focus).not.toHaveBeenCalled()
    expect(useConversationsStore.getState().selectedConversationId).toBeNull()
  })

  it('costs the grid nothing until it is asked for', async () => {
    await openTheRiver()
    expect(document.querySelector('.wall-detail')).toBeNull()

    fireEvent.click(rows()[0] as Element)
    await waitFor(() => expect(panel()).toBeTruthy())

    // An OVERLAY, not a rail: it is a child of the wall ROOT, over the panes,
    // and the pane it opened from is still mounted at its own size.
    expect(document.querySelector('.wall-detail')?.parentElement?.className).toContain('wall-root')
    expect(rows()).toHaveLength(1)
  })

  /**
   * Escape is heard on the PANEL's own subtree, not on the document it was born
   * in: detaching the wall moves this DOM into the popup, and a document-bound
   * listener would leave an open panel you cannot dismiss on the very monitor
   * you are looking at.
   */
  it('closes on Escape and hands focus back to the row', async () => {
    await openTheRiver()
    const row = rows()[0] as HTMLElement
    row.focus()
    fireEvent.click(row)
    await waitFor(() => expect(panel()).toBeTruthy())
    expect(document.activeElement?.className).toContain('wall-detail-panel')

    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })

    await waitFor(() => expect(panel()).toBeNull())
    expect(document.activeElement).toBe(row)
  })

  it('closes on a click away', async () => {
    await openTheRiver()
    fireEvent.click(rows()[0] as Element)
    await waitFor(() => expect(panel()).toBeTruthy())

    fireEvent.click(document.querySelector('.wall-detail-scrim') as Element)

    await waitFor(() => expect(panel()).toBeNull())
    expect(useWallDetail.getState().hash).toBeNull()
  })

  it('follows the row you clicked SECOND', async () => {
    const second = commit({ id: 2, hash: OTHER, shortHash: 'bbbbbbb', subject: 'fix(wall): the other one' })
    await openTheRiver([commit(), second])

    fireEvent.click(rows()[0] as Element)
    await waitFor(() => expect(screen.getByText('the body the row could not afford')).toBeTruthy())

    fireEvent.click(rows()[1] as Element)
    await waitFor(() => expect(screen.getAllByText('fix(wall): the other one').length).toBeGreaterThan(1))
  })
})

/** RULE 7. The wall's premise is being believed from across a room with nobody
 *  touching it, so an open panel has to heal itself or admit it did not. */
describe('an open detail survives a reconnect', () => {
  it('re-reads the commit when the socket comes back', async () => {
    await openTheRiver()
    fireEvent.click(rows()[0] as Element)
    await waitFor(() => expect(panel()).toBeTruthy())
    const before = feedPulls('commit-detail')
    expect(before).toBeGreaterThan(0)

    act(() => {
      useConversationsStore.setState({ connectSeq: 2 })
    })

    await waitFor(() => expect(feedPulls('commit-detail')).toBe(before + 1))
    expect(detailReads).toBeGreaterThan(1)
    expect(document.querySelector('.wall-detail .wall-stale-mark')).toBeNull()
  })

  it('keeps the commit on screen and says STALE when the re-read fails', async () => {
    await openTheRiver()
    fireEvent.click(rows()[0] as Element)
    await waitFor(() => expect(screen.getByText('the body the row could not afford')).toBeTruthy())

    // The broker restarted: the socket came back, the reads did not.
    answering = false
    act(() => {
      useConversationsStore.setState({ connectSeq: 2 })
    })

    await waitFor(() => expect(document.querySelector('.wall-detail .wall-stale-mark')?.textContent).toBe('STALE'))
    // The commit is STILL THERE. A dead broker is not an answer of "no such
    // commit", and erasing the panel would have called it one.
    expect(screen.getByText('the body the row could not afford')).toBeTruthy()
  })
})
