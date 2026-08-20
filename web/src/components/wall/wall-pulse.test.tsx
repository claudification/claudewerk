/**
 * P1 as it RENDERS: the band vocabulary, the two views, the count, the chip that
 * drives the whole wall, and the click that both MARKS and opens.
 *
 * `usePulseFleet` is mocked -- its own banding, sorting and managed detection are
 * pinned by `src/components/pulse/` and `src/lib/pulse/`. What is under test here
 * is the MOUNT: that the pane filters through the shared wall query and nothing
 * else, and that it reports honestly what it dropped.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PulseFleet, PulseRow } from '@/components/pulse/use-pulse-fleet'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { PulseBand } from '@/lib/pulse/bands'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { parseWallQuery } from '@/lib/wall/query'
import PulsePane from './panes/p1-pulse'
import { useWallPulseStore } from './wall-pulse-state'

const feed = vi.hoisted(() => ({ fleet: null as PulseFleet | null }))
vi.mock('@/components/pulse/use-pulse-fleet', async importOriginal => ({
  ...(await importOriginal<typeof import('@/components/pulse/use-pulse-fleet')>()),
  usePulseFleet: () => feed.fleet,
}))

let seq = 0
function row(over: Partial<PulseRow> = {}): PulseRow {
  seq += 1
  return {
    id: `conv_${seq}`,
    conversation: { id: `conv_${seq}` } as PulseRow['conversation'],
    band: 'working',
    title: `thing ${seq}`,
    project: 'remote-claude',
    action: 'editing pulse-strip.tsx',
    ageMs: 60_000,
    ...over,
  }
}

const ZERO: Record<PulseBand, number> = { blocked: 0, needs: 0, working: 0, done: 0, idle: 0, expired: 0 }

/** What the feed hands the pane: the WHOLE fleet, filtered by nothing. */
function feedFleet(flat: PulseRow[], expired: PulseRow[] = []): PulseFleet {
  return {
    groups: [],
    flat,
    totals: ZERO,
    expired,
    hidden: 0,
    managedHidden: 0,
    query: parseWallQuery('+over'),
    isEmpty: false,
  }
}

function countSlot(container: HTMLElement): string {
  return container.querySelector('.wall-pane-count')?.textContent ?? ''
}

beforeEach(() => {
  feed.fleet = feedFleet([])
  useWallFilterStore.getState().clear()
  useWallPulseStore.setState({ view: 'bands', selectedId: null })
})
afterEach(() => {
  cleanup()
  useConversationsStore.setState({ selectedConversationId: null })
  vi.restoreAllMocks()
})

describe('P1 pulse -- bands', () => {
  it('groups rows under the shared band vocabulary', () => {
    feed.fleet = feedFleet([row({ band: 'blocked' }), row({ band: 'working' })])
    render(<PulsePane />)
    expect(screen.getByText('BLOCKED ON YOU')).toBeTruthy()
    expect(screen.getByText('WORKING')).toBeTruthy()
  })

  it('prints a blocked row reason ONCE, in rose', () => {
    // The reviewed mockup printed the block twice -- the noun AND the action.
    // One marker, one hue: from across the room the point is that something is
    // stopped, and a second copy just makes the row longer.
    feed.fleet = feedFleet([
      row({ band: 'blocked', title: 'fork 502 root cause', blockedBy: 'permission', action: 'permission: Bash rm' }),
    ])
    render(<PulsePane />)
    const rowEl = screen.getByText('fork 502 root cause').closest('button')
    expect(rowEl).toBeTruthy()
    // ONE marker naming what the agent is stuck on, and it is the rose one. The
    // band glyph and the card edge are rose too -- that is the band's colour, not
    // a second copy of the reason.
    const markers = [...(rowEl?.querySelectorAll('span') ?? [])].filter(el => el.textContent === 'PERMISSION')
    expect(markers).toHaveLength(1)
    expect(markers[0].className).toContain('rose')
    expect(screen.getAllByText('permission: Bash rm')).toHaveLength(1)
  })

  it('switches to the tide and back, and the tide drops the band headers', () => {
    feed.fleet = feedFleet([row({ band: 'needs' })])
    render(<PulsePane />)
    expect(screen.getByText('NEEDS YOU')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'TIDE' }))
    expect(screen.queryByText('NEEDS YOU')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'BANDS' }))
    expect(screen.getByText('NEEDS YOU')).toBeTruthy()
  })
})

describe('P1 pulse -- the shared filter', () => {
  it('renders matched/total in the pane count slot', () => {
    feed.fleet = feedFleet([row({ title: 'keep me' }), row({ title: 'drop me' })])
    const { container } = render(<PulsePane />)
    expect(countSlot(container)).toBe('2/2')
    act(() => useWallFilterStore.getState().setRaw('keep'))
    expect(countSlot(container)).toBe('1/2')
    expect(screen.queryByText('drop me')).toBeNull()
  })

  it('empties to 0/N with a reason, never to a silent blank pane', () => {
    feed.fleet = feedFleet([row(), row()])
    const { container } = render(<PulsePane />)
    act(() => useWallFilterStore.getState().setRaw('%99'))
    expect(countSlot(container)).toBe('0/2')
    expect(screen.getByText(/nothing matches/)).toBeTruthy()
  })

  it('says how many rows the query took out while some still show', () => {
    feed.fleet = feedFleet([row({ title: 'keep me' }), row(), row()])
    render(<PulsePane />)
    act(() => useWallFilterStore.getState().setRaw('keep'))
    expect(screen.getByText('2 hidden by filter')).toBeTruthy()
  })

  it('hides machine-dispatched rows by default and counts them apart from the filter', () => {
    feed.fleet = feedFleet([
      row({ title: 'human run' }),
      row({ title: 'epic seat', managed: true, managedBy: { kind: 'epic', label: 'OVER', runId: 'ep_1' } }),
    ])
    const { container } = render(<PulsePane />)
    expect(screen.queryByText('epic seat')).toBeNull()
    expect(countSlot(container)).toBe('1/2 (1 over)')
    expect(screen.getByText(/1 machine-run hidden/)).toBeTruthy()
  })

  it('reveals them by writing +over into the wall query box', () => {
    feed.fleet = feedFleet([
      row({ title: 'human run' }),
      row({ title: 'epic seat', managed: true, managedBy: { kind: 'epic', label: 'OVER', runId: 'ep_1' } }),
    ])
    const { container } = render(<PulsePane />)
    fireEvent.click(screen.getByText(/machine-run hidden/))
    expect(useWallFilterStore.getState().raw).toBe('+over')
    expect(screen.getByText('epic seat')).toBeTruthy()
    expect(countSlot(container)).toBe('2/2')
  })

  it('scopes the whole wall from a project chip, and clears on a second click', () => {
    feed.fleet = feedFleet([row({ title: 'ours' }), row({ title: 'theirs', project: 'anvil-md' })])
    render(<PulsePane />)
    const chip = screen.getByText('ours').closest('button')?.querySelector('[data-project="remote-claude"]')
    expect(chip).toBeTruthy()
    fireEvent.click(chip as Element)
    expect(useWallFilterStore.getState().raw).toBe('@remote-claude')
    // The chip click is NOT a row click: scoping the wall must not also select.
    expect(useWallPulseStore.getState().selectedId).toBeNull()
    expect(screen.queryByText('theirs')).toBeNull()

    fireEvent.click(screen.getByText('ours').closest('button')?.querySelector('[data-project]') as Element)
    expect(useWallFilterStore.getState().raw).toBe('')
  })
})

describe('P1 pulse -- selection', () => {
  it('marks a row, and unmarks it on a second click', () => {
    feed.fleet = feedFleet([row({ title: 'pick me' })])
    render(<PulsePane />)
    const rowEl = () => screen.getByText('pick me').closest('button') as HTMLElement
    fireEvent.click(rowEl())
    expect(rowEl().getAttribute('data-active')).toBe('true')
    fireEvent.click(rowEl())
    expect(rowEl().getAttribute('data-active')).toBe('false')
  })

  /**
   * The mark and the open are two verbs on one click, and W4 is the second.
   * `wall-pulse-state` says selection is not navigation; that stayed true --
   * what changed is that the pane now ALSO drives the main window, and the mark
   * has to survive it or the row you clicked stops reading as the row you
   * clicked the moment the dashboard comes forward.
   */
  it('ALSO focuses the conversation in the main window, and keeps the mark', () => {
    feed.fleet = feedFleet([row({ id: 'conv_pick', title: 'pick me' })])
    render(<PulsePane />)

    fireEvent.click(screen.getByText('pick me'))

    expect(useConversationsStore.getState().selectedConversationId).toBe('conv_pick')
    expect(useWallPulseStore.getState().selectedId).toBe('conv_pick')
  })

  it('survives a remount -- the wall unmounts its tree on every dock and detach', () => {
    feed.fleet = feedFleet([row({ title: 'pick me' })])
    const first = render(<PulsePane />)
    fireEvent.click(screen.getByText('pick me'))
    first.unmount()
    render(<PulsePane />)
    expect((screen.getByText('pick me').closest('button') as HTMLElement).getAttribute('data-active')).toBe('true')
  })
})
