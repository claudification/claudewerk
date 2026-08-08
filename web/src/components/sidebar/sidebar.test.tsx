import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { SidebarState } from './sidebar-open-state'

// The list itself is not under test here; its render cost and store appetite are
// beside the point. What IS under test is whether the sidebar keeps it mounted.
vi.mock('@/components/project-list', () => ({
  ProjectList: () => <div data-testid="project-list" />,
}))
vi.mock('@/components/recap-jobs/recap-jobs-widget', () => ({
  RecapJobsWidget: () => null,
}))

const { Sidebar } = await import('./sidebar')

function makeState(over: Partial<SidebarState> = {}): SidebarState {
  return { open: true, overlay: false, toggle: vi.fn(), show: vi.fn(), close: vi.fn(), ...over }
}

beforeEach(() => {
  useConversationsStore.setState({
    selectedConversationId: 'conv-1',
  } as unknown as ReturnType<typeof useConversationsStore.getState>)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Sidebar', () => {
  // THE REGRESSION, and the reason this component exists. The old mobile sheet
  // was a Radix Dialog with no forceMount, so closing it UNMOUNTED the whole
  // conversation list. Every open rebuilt it from scratch at scrollTop 0 with no
  // remembered row heights, which is what made it scroll in from the left and
  // then hunt for -- and miss -- the current conversation.
  it('keeps the conversation list mounted while closed', () => {
    const { rerender } = render(<Sidebar state={makeState({ open: true, overlay: true })} />)
    expect(screen.getByTestId('project-list')).toBeTruthy()

    rerender(<Sidebar state={makeState({ open: false, overlay: true })} />)
    expect(screen.getByTestId('project-list')).toBeTruthy()
  })

  // display:none resets scrollTop on restore; a transform does not. Hiding this
  // node the wrong way would silently reintroduce the whole bug.
  it('hides by transform, never by display:none', () => {
    render(<Sidebar state={makeState({ open: false, overlay: true })} />)
    const aside = document.querySelector('aside')
    expect(aside?.className).toContain('-translate-x-full')
    // A bare `hidden` (or an `lg:hidden`) is display:none. Checked as classes,
    // not substrings -- `lg:overflow-hidden` is fine and must not trip this.
    const classes = [...(aside?.classList ?? [])]
    expect(classes.filter(c => c === 'hidden' || c.endsWith(':hidden'))).toEqual([])
  })

  it('slides in when open', () => {
    render(<Sidebar state={makeState({ open: true, overlay: true })} />)
    expect(document.querySelector('aside')?.className).toContain('translate-x-0')
  })

  // Off-canvas and collapsed-to-zero are both unreachable; neither should hold
  // focus or answer a tap that lands on where it used to be.
  it('is inert while closed and interactive while open', () => {
    const { rerender } = render(<Sidebar state={makeState({ open: false })} />)
    expect(document.querySelector('aside')?.hasAttribute('inert')).toBe(true)

    rerender(<Sidebar state={makeState({ open: true })} />)
    expect(document.querySelector('aside')?.hasAttribute('inert')).toBe(false)
  })

  it('collapses the docked sidebar by clipping width, keeping the panel intact', () => {
    render(<Sidebar state={makeState({ open: false, overlay: false })} />)
    const aside = document.querySelector('aside')
    expect(aside?.className).toContain('lg:w-0')
    expect(aside?.className).toContain('lg:overflow-hidden')
  })

  it('renders a dismiss scrim only in overlay mode', () => {
    const { rerender } = render(<Sidebar state={makeState({ open: true, overlay: false })} />)
    expect(screen.queryByTestId('sidebar-scrim')).toBeNull()

    rerender(<Sidebar state={makeState({ open: true, overlay: true })} />)
    expect(screen.queryByTestId('sidebar-scrim')).toBeTruthy()
  })

  it('closes the overlay once a conversation is selected', () => {
    const close = vi.fn()
    render(<Sidebar state={makeState({ open: true, overlay: true, close })} />)
    expect(close).toHaveBeenCalled()
  })

  it('leaves the docked sidebar open when a conversation is selected', () => {
    const close = vi.fn()
    render(<Sidebar state={makeState({ open: true, overlay: false, close })} />)
    expect(close).not.toHaveBeenCalled()
  })

  it('dismisses the overlay on Escape', () => {
    const close = vi.fn()
    useConversationsStore.setState({ selectedConversationId: null } as unknown as ReturnType<
      typeof useConversationsStore.getState
    >)
    render(<Sidebar state={makeState({ open: true, overlay: true, close })} />)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(close).toHaveBeenCalledTimes(1)
  })
})
