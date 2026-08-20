/**
 * A8 as it RENDERS: the counts beside every bar, the cap that says so, the hover
 * that stays put and the click that leaves.
 *
 * `useWallPins` is mocked because its feed is a sentinel-side board op over a
 * websocket -- what this suite is about is the pane, and the fold behind it has
 * its own suite (`src/shared/pinned-epic-rows.test.ts`).
 */

import { MARKER, type PinnedChildRow } from '@shared/pinned-epic-rows'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import PinnedEpicsPane from './panes/a8-pinned'
import type { WallPinRow } from './use-wall-pins'

const pins = vi.hoisted(() => ({ rows: [] as WallPinRow[] }))
vi.mock('./use-wall-pins', () => ({ useWallPins: () => ({ rows: pins.rows, stale: false }) }))

const PROJECT = 'claude:///Users/j/remote-claude'

function kid(slug: string, marker: PinnedChildRow['marker'] = MARKER.moving): PinnedChildRow {
  return { slug, title: slug, marker, lane: 'open', mtime: 0 }
}

function pinRow(over: Partial<WallPinRow> = {}): WallPinRow {
  const children = over.children ?? [kid('wall-surface-shell')]
  return {
    project: PROJECT,
    projectName: 'remote-claude',
    epicId: 'epic-the-wall',
    epicTitle: 'THE WALL',
    done: 7,
    total: 17,
    pct: 41,
    cap: 5,
    hidden: 0,
    movedAt: 1,
    ...over,
    children,
  }
}

beforeEach(() => {
  pins.rows = []
  useModalManagerStore.setState({ records: {} })
  useWallFilterStore.getState().clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the pinned-epics pane', () => {
  it('says what to do when nothing is pinned', () => {
    render(<PinnedEpicsPane />)
    expect(screen.getByText('nothing pinned -- pin an epic from the board to watch it here')).toBeTruthy()
  })

  it('puts the counts NEXT TO the bar -- a bar alone is a lie about scale', () => {
    pins.rows = [pinRow()]
    render(<PinnedEpicsPane />)

    expect(screen.getByText('7/17')).toBeTruthy()
    expect(screen.getByText('41%')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('41')
  })

  it('caps the list and SAYS how many it hid', () => {
    const children = Array.from({ length: 8 }, (_, i) => kid(`card-${i}`))
    pins.rows = [pinRow({ children, cap: 5, hidden: 3 })]
    render(<PinnedEpicsPane />)

    expect(screen.getAllByText(/^card-\d$/)).toHaveLength(5)
    expect(screen.getByText('+ 3 more not closed')).toBeTruthy()
  })

  it('HOVER reveals what the cap hid, on the wall, and navigates nothing', () => {
    const children = Array.from({ length: 8 }, (_, i) => kid(`card-${i}`))
    pins.rows = [pinRow({ children, cap: 5, hidden: 3 })]
    render(<PinnedEpicsPane />)

    fireEvent.mouseEnter(document.querySelector('.wall-pin') as HTMLElement)

    expect(screen.getAllByText(/^card-\d$/)).toHaveLength(8)
    expect(screen.queryByText('+ 3 more not closed')).toBeNull()
    // Never opens anything, never steals focus: a hover is a preview.
    expect(Object.keys(useModalManagerStore.getState().records)).toHaveLength(0)

    fireEvent.mouseLeave(document.querySelector('.wall-pin') as HTMLElement)
    expect(screen.getAllByText(/^card-\d$/)).toHaveLength(5)
  })

  it('CLICKING the epic hands the intent to the main window', () => {
    pins.rows = [pinRow()]
    render(<PinnedEpicsPane />)

    fireEvent.click(screen.getByText('THE WALL'))
    expect(useModalManagerStore.getState().records.kanban?.scope).toEqual({ type: 'project', uri: PROJECT })
  })

  it('CLICKING a card line opens that card, one level down', () => {
    pins.rows = [pinRow({ children: [kid('wall-live-channel')] })]
    render(<PinnedEpicsPane />)

    fireEvent.click(screen.getByText('wall-live-channel'))
    expect(useModalManagerStore.getState().records.kanban).toBeTruthy()
  })

  it('the project chip FILTERS the wall rather than navigating', () => {
    pins.rows = [pinRow()]
    render(<PinnedEpicsPane />)

    fireEvent.click(screen.getByText('remote-claude'))

    expect(useWallFilterStore.getState().raw).toContain('remote-claude')
    expect(Object.keys(useModalManagerStore.getState().records)).toHaveLength(0)
  })

  it('renders {matched}/{total} in the count slot and stays FULL for an axis it does not declare', () => {
    pins.rows = [pinRow(), pinRow({ epicId: 'other', epicTitle: 'TING VOICE', projectName: 'gate-meet' })]
    render(<PinnedEpicsPane />)
    expect(screen.getByText('2/2 pinned')).toBeTruthy()

    // `%80` is context pressure -- an epic has none, so the pane must not blank.
    act(() => useWallFilterStore.getState().setRaw('%80'))
    expect(screen.getByText('2/2 pinned')).toBeTruthy()

    // A project scope IS an axis it declares.
    act(() => useWallFilterStore.getState().setRaw('@gate-meet'))
    expect(screen.getByText('1/2 pinned')).toBeTruthy()
  })
})
