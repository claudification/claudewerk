/**
 * A5 as it RENDERS: the strip, the segments, the legend, and the two contracts
 * that are not maths -- the wall count slot, and staying FULL for an axis this
 * surface does not declare.
 *
 * jsdom has no layout and no ResizeObserver, so every segment here is in its
 * measured-nothing state and prints its count. That is deliberate: it is also
 * the first paint in a real browser, and it must never be the broken one.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@/lib/types'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import NowBar from './panes/a5-now-bar'

const NOW = 1_700_000_000_000

const fake = vi.hoisted(() => ({
  state: {
    pendingPermissions: [] as unknown[],
    pendingProjectLinks: [] as unknown[],
    pendingAskQuestions: [] as unknown[],
    pendingDialogs: {} as Record<string, unknown>,
    projectSettings: {} as Record<string, unknown>,
    conversations: [] as unknown[],
  },
}))

vi.mock('@/hooks/use-conversations', () => {
  const store = (sel: (s: typeof fake.state) => unknown) => sel(fake.state)
  store.getState = () => fake.state
  return { useConversationsStore: store, useConversations: () => fake.state.conversations }
})

let seq = 0
function conv(over: Partial<Conversation> = {}): Conversation {
  seq += 1
  return {
    id: `conv_${seq}`,
    project: 'claude:///Users/j/remote-claude',
    status: 'active',
    title: `thing ${seq}`,
    lastActivity: NOW - 10_000,
    ...over,
  } as unknown as Conversation
}

/** A conversation CC classified as stuck while nothing un-fakeable is pending. */
const classified = (category: string, over: Partial<Conversation> = {}) =>
  conv({ turnSummary: { category, detail: 'wiring the strip', updatedAt: NOW }, ...over } as Partial<Conversation>)

const segments = () => Array.from(document.querySelectorAll<HTMLElement>('.wall-nowseg'))
const classes = () => segments().map(s => s.dataset.now)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  fake.state.pendingPermissions = []
  fake.state.pendingProjectLinks = []
  fake.state.pendingAskQuestions = []
  fake.state.pendingDialogs = {}
  fake.state.conversations = []
  useWallFilterStore.getState().clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('the A5 now bar', () => {
  it('is the strip, not a pane -- no pane head, and it keeps its reference code', () => {
    render(<NowBar />)
    const strip = document.querySelector('[data-pane="A5"]')
    expect(strip?.classList.contains('wall-nowbar')).toBe(true)
    expect(strip?.querySelector('.wall-pane-head')).toBeNull()
    expect(screen.getByText('A5')).toBeTruthy()
  })

  it('says so plainly when there is no fleet, instead of drawing an empty bar', () => {
    render(<NowBar />)
    expect(screen.getByText('no conversations')).toBeTruthy()
    expect(segments()).toHaveLength(0)
  })

  it('draws one segment per non-empty class, widths proportional to the counts', () => {
    fake.state.conversations = [conv(), conv(), conv({ status: 'idle', lastActivity: NOW - 3_600_000 })]
    render(<NowBar />)

    expect(classes()).toEqual(['working', 'idle'])
    expect(segments().map(s => s.style.flexGrow)).toEqual(['2', '1'])
    // Nobody is blocked, so there is no rose sliver to hover.
    expect(classes()).not.toContain('waiting')
  })

  it('degrades every segment to its count while the bar is unmeasured', () => {
    fake.state.conversations = [conv(), conv()]
    render(<NowBar />)
    expect(segments()[0]?.textContent).toBe('2')
    // The reading is not lost -- it moved to the title.
    expect(segments()[0]?.title).toBe('2 working')
  })

  it('lets the BAND own attention -- the classifier cannot move a row into it', () => {
    // CC's own word for its turn is `blocked`. Nothing un-fakeable is pending, so
    // this is the lower-trust reading and it gets amber, not the alarm hue.
    const stuck = classified('blocked')
    fake.state.conversations = [stuck]
    render(<NowBar />)
    expect(classes()).toEqual(['stalled'])

    // Now a real permission is parked on it. The band says WAITING and wins.
    act(() => {
      fake.state.pendingPermissions = [{ conversationId: stuck.id, requestId: 'r1', timestamp: NOW }]
      fake.state.conversations = [{ ...stuck }]
      vi.advanceTimersByTime(1_000)
    })
    expect(classes()).toEqual(['waiting'])
  })

  it('renders the wall count slot, and stays FULL for an axis it does not declare', () => {
    fake.state.conversations = [conv(), conv()]
    render(<NowBar />)
    expect(screen.getByTitle('shown / whole fleet').textContent).toBe('2/2')

    // `+only` is the `managed` axis, which A5 does not declare. An undeclared
    // axis is cleared from the query, so the bar stays FULL rather than blank.
    act(() => useWallFilterStore.getState().setRaw('+only'))
    expect(screen.getByTitle('shown / whole fleet').textContent).toBe('2/2')

    // `!!!` is the blocked band, which A5 DOES declare -- so it filters.
    act(() => useWallFilterStore.getState().setRaw('!!!'))
    expect(screen.getByTitle('shown / whole fleet').textContent).toBe('0/2')
    expect(screen.getByText('nothing matches')).toBeTruthy()
  })

  it('counts machine-dispatched runs, because a fleet bar that hides them lies', () => {
    // `managed` is not one of A5's axes, so the grammar's hide-by-default is
    // cleared and an epic seat shows up in the bar like anything else.
    fake.state.conversations = [
      conv({ epic: { epicId: 'epic-the-wall', role: 'werk-worker' } } as Partial<Conversation>),
      conv(),
    ]
    render(<NowBar />)
    expect(screen.getByTitle('shown / whole fleet').textContent).toBe('2/2')
  })
})
