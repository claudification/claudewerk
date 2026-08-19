/**
 * P3: the four claims the card makes about the pane.
 *
 *  - live moves appear with no refetch (there is no fetch here at all -- the
 *    wall frame is the only feed)
 *  - the DONE tab shows only completions
 *  - a row click opens THAT card, on ITS project's board
 *  - the filter is the shared one: declared axes bite, undeclared axes leave the
 *    pane FULL, `{matched}/{total}` rides the WallPane count slot, and the
 *    project dot goes through the store's exported action
 */

import type { CardMove } from '@shared/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyCardLedgerFrame, resetCardLedger } from '@/hooks/card-ledger-feed'
import { useConversationsStore } from '@/hooks/use-conversations'
import { KANBAN_MODAL } from '@/hooks/use-kanban-modal'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { useCardLedgerViewStore } from './card-ledger-view'
import CardLedgerPane from './p3-card-ledger'

const NOW = new Date(2026, 7, 20, 14, 0, 0).getTime()
const MIN = 60_000
const ALPHA = 'claude://default/Users/x/alpha'
const BETA = 'claude://default/Users/x/beta'

function move(over: Partial<CardMove> = {}): CardMove {
  return {
    id: 'wall-pane-card-ledger',
    project: ALPHA,
    title: 'the card ledger pane',
    from: 'in-progress',
    to: 'in-review',
    priority: 'medium',
    ts: NOW - 5 * MIN,
    ...over,
  }
}

/** Seed the module-global feed the way a fresh subscribe does, then mount. */
function mount(moves: CardMove[]) {
  applyCardLedgerFrame(moves, { full: true })
  return render(<CardLedgerPane />)
}

const rows = () => [...document.querySelectorAll('.wall-ledger-row')]
const titles = () => rows().map(row => row.querySelector('.wall-ledger-title')?.textContent)
const countSlot = () => document.querySelector('.wall-pane-count')?.textContent ?? ''

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  resetCardLedger()
  useWallFilterStore.getState().clear()
  useCardLedgerViewStore.setState({ view: 'all' })
  useModalManagerStore.setState({ records: {} })
  useConversationsStore.setState({ pendingTaskEdit: null })
})

afterEach(() => {
  cleanup()
  resetCardLedger()
  vi.useRealTimers()
})

describe('P3 card ledger', () => {
  it('renders the specified row: age, project dot, title, priority, from -> to', () => {
    mount([move()])
    const row = rows()[0]
    expect(row?.querySelector('.wall-ledger-t')?.textContent).toBe('5m')
    // A DOT, carrying the project's name on the seam the wall clicks.
    expect(row?.querySelector('.wall-ledger-dot')?.getAttribute('data-project')).toBe('alpha')
    expect(row?.querySelector('.wall-ledger-title')?.textContent).toBe('the card ledger pane')
    expect(row?.querySelector('.wall-ledger-prio')?.textContent).toBe('medium')
    expect(row?.querySelector('.wall-ledger-from')?.textContent).toBe('in-progress')
    expect(row?.querySelector('.wall-ledger-to')?.textContent).toBe('in-review')
  })

  it('emphasises the destination only when it is done', () => {
    mount([move({ id: 'closed', to: 'done' }), move({ id: 'moved', ts: NOW - 6 * MIN })])
    const [first, second] = rows()
    expect(first?.querySelector('.wall-ledger-to')?.className).toContain('wall-ledger-done')
    expect(second?.querySelector('.wall-ledger-to')?.className).not.toContain('wall-ledger-done')
  })

  it('orders newest first', () => {
    mount([
      move({ id: 'mid', title: 'mid', ts: NOW - 5 * MIN }),
      move({ id: 'oldest', title: 'oldest', ts: NOW - 60 * MIN }),
      move({ id: 'newest', title: 'newest', ts: NOW - MIN }),
    ])
    expect(titles()).toEqual(['newest', 'mid', 'oldest'])
  })

  it('streams a live move in without a refetch -- the frame IS the feed', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    mount([move()])
    expect(rows()).toHaveLength(1)

    act(() => {
      applyCardLedgerFrame([move({ id: 'landed-live', title: 'landed live', ts: NOW })], { full: false })
    })

    expect(rows()).toHaveLength(2)
    expect(screen.getByText('landed live')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('DONE shows only the completions, and ALL puts the rest back', () => {
    mount([
      move({ id: 'closed', title: 'closed', to: 'done', ts: NOW - MIN }),
      move({ id: 'reviewing', title: 'reviewing', ts: NOW - 2 * MIN }),
      // A card LEAVING done is not a completion.
      move({ id: 'reopened', title: 'reopened', from: 'done', to: 'open', ts: NOW - 3 * MIN }),
    ])
    expect(titles()).toEqual(['closed', 'reviewing', 'reopened'])

    fireEvent.click(screen.getByText('DONE'))
    expect(titles()).toEqual(['closed'])
    expect(countSlot()).toBe('1/1')

    fireEvent.click(screen.getByText('ALL'))
    expect(titles()).toHaveLength(3)
  })

  it('opens THAT card on ITS project board when the row is clicked', () => {
    mount([move({ id: 'wall-time-cursor', project: BETA })])
    fireEvent.click(rows()[0] as Element)

    expect(useConversationsStore.getState().pendingTaskEdit).toEqual({ slug: 'wall-time-cursor' })
    expect(useModalManagerStore.getState().records[KANBAN_MODAL.id]?.scope).toEqual({ type: 'project', uri: BETA })
  })

  it('renders {matched}/{total} in the pane count slot and filters on a declared axis', () => {
    mount([move(), move({ id: 'b', project: BETA, ts: NOW - 6 * MIN })])
    expect(countSlot()).toBe('2/2')

    act(() => {
      useWallFilterStore.getState().setRaw('@beta')
    })
    expect(countSlot()).toBe('1/2')
    expect(rows()).toHaveLength(1)
  })

  it('finds a move by the card SLUG, not just its title', () => {
    mount([move({ id: 'wall-time-cursor', title: 'a title that says nothing' }), move({ id: 'other', ts: NOW - MIN })])
    act(() => {
      useWallFilterStore.getState().setRaw('time-cursor')
    })
    expect(rows()).toHaveLength(1)
    expect(titles()).toEqual(['a title that says nothing'])
  })

  it('stays FULL under an axis it never declared', () => {
    mount([move()])
    // `%80` is context pressure and `:opus` is a model -- a card move has
    // neither facet, and the pane declares neither axis, so it must drop nobody.
    act(() => {
      useWallFilterStore.getState().setRaw('%80 :opus')
    })
    // Guard against a vacuous pass: the query really did parse into two
    // constraints, they are simply not ones this pane declared.
    expect(useWallFilterStore.getState().query.minContextPct).toBe(80)
    expect(useWallFilterStore.getState().query.model).toBe('opus')
    expect(countSlot()).toBe('1/1')
    expect(rows()).toHaveLength(1)
  })

  it('scopes the wall from the project dot THROUGH the store action', () => {
    mount([move()])
    fireEvent.click(document.querySelector('[data-project]') as Element)
    expect(useWallFilterStore.getState().raw).toBe('@alpha')

    // The same action toggles it back off -- proof this is the store's chip
    // handler and not a local set-the-filter of our own.
    fireEvent.click(document.querySelector('[data-project]') as Element)
    expect(useWallFilterStore.getState().raw).toBe('')
    // And the dot click never opened the card on the way past.
    expect(useConversationsStore.getState().pendingTaskEdit).toBeNull()
  })

  it('tells an empty ledger, an empty DONE tab and an empty filter apart', () => {
    mount([])
    expect(screen.getByText('no card has moved yet')).toBeTruthy()

    fireEvent.click(screen.getByText('DONE'))
    expect(screen.getByText('nothing has reached done yet')).toBeTruthy()

    cleanup()
    // The tab is module state ON PURPOSE -- it survives the surface being
    // detached and remounted -- so a remount does NOT put it back to ALL.
    expect(useCardLedgerViewStore.getState().view).toBe('done')
    useCardLedgerViewStore.setState({ view: 'all' })

    mount([move()])
    act(() => {
      useWallFilterStore.getState().setRaw('@nowhere')
    })
    expect(screen.getByText('no move matches the filter')).toBeTruthy()
  })
})
