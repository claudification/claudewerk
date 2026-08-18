import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { _resetConversationsMemoForTests } from '@/lib/slim-conversation'
import * as utils from '@/lib/utils'
import { PulseStrip } from './pulse-strip'

/**
 * The strip is a SELECTOR: you open it to pick a conversation, and picking one
 * must take you there AND get out of the way. It previously navigated but left
 * itself open behind the conversation you had just opened.
 */
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  // selectConversations memoises on the byId identity at module scope, so a
  // stale cache from a previous case would hand this one an empty fleet.
  _resetConversationsMemoForTests()
  useConversationsStore.setState({
    conversationsById: {},
    controlPanelPrefs: { ...useConversationsStore.getState().controlPanelPrefs, pulseStrip: true },
    showPulse: false,
  })
})

const desktop = () => vi.spyOn(utils, 'isMobileViewport').mockReturnValue(false)
const mobile = () => vi.spyOn(utils, 'isMobileViewport').mockReturnValue(true)

describe('PulseStrip', () => {
  it('renders nothing at all when the pref is off', () => {
    useConversationsStore.setState({
      controlPanelPrefs: { ...useConversationsStore.getState().controlPanelPrefs, pulseStrip: false },
    })
    const { container } = render(<PulseStrip onOpen={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the bar when enabled', () => {
    desktop()
    render(<PulseStrip onOpen={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Pulse strip' })).toBeTruthy()
  })

  it('blooms in place on desktop', () => {
    desktop()
    render(<PulseStrip onOpen={vi.fn()} />)
    const bar = screen.getByRole('button', { name: 'Pulse strip' })
    expect(bar.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(bar)
    expect(bar.getAttribute('aria-expanded')).toBe('true')
    expect(useConversationsStore.getState().showPulse).toBe(false)
  })

  it('opens the FULL-SCREEN selector on mobile instead of blooming', () => {
    // A 30px bar with a 52vh drawer hanging off it is the wrong shape on a
    // phone; the palette is already a full-height sheet with search at the thumb.
    mobile()
    render(<PulseStrip onOpen={vi.fn()} />)
    const bar = screen.getByRole('button', { name: 'Pulse strip' })
    fireEvent.click(bar)
    expect(useConversationsStore.getState().showPulse).toBe(true)
    expect(bar.getAttribute('aria-expanded')).toBe('false')
  })

  it('SELECTING A ROW navigates and dismisses itself', () => {
    // The bug this pins: it used to navigate and stay open, leaving the strip
    // bloomed on top of the conversation it had just taken you to.
    desktop()
    _resetConversationsMemoForTests()
    useConversationsStore.setState({
      conversationsById: {
        conv_1: {
          id: 'conv_1',
          project: 'claude:///Users/jonas/projects/remote-claude',
          status: 'active',
          title: 'a live conversation',
          startedAt: Date.now() - 60_000,
          lastActivity: Date.now() - 5_000,
        },
      } as never,
    })

    const onOpen = vi.fn()
    render(<PulseStrip onOpen={onOpen} />)
    const bar = screen.getByRole('button', { name: 'Pulse strip' })
    fireEvent.click(bar)
    expect(bar.getAttribute('aria-expanded')).toBe('true')

    // The single most urgent conversation appears TWICE by design: inline on
    // the collapsed bar as the lead, and again as a row in the bloomed list.
    // The second is the selectable one.
    const rows = screen.getAllByText('a live conversation')
    expect(rows).toHaveLength(2)

    fireEvent.click(rows[1])
    expect(onOpen).toHaveBeenCalledWith('conv_1')
    expect(bar.getAttribute('aria-expanded')).toBe('false')
  })

  it('collapses when Escape is pressed', () => {
    desktop()
    render(<PulseStrip onOpen={vi.fn()} />)
    const bar = screen.getByRole('button', { name: 'Pulse strip' })
    fireEvent.click(bar)
    expect(bar.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(bar.getAttribute('aria-expanded')).toBe('false')
  })
})
