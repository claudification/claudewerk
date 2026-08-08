import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSidebarOpen } from './sidebar-open-state'

// jsdom has no matchMedia. This stub is also the only way to simulate crossing
// the layout breakpoint without a real viewport.
type Listener = () => void
let overlayMatches = false
const listeners = new Set<Listener>()

function setOverlay(next: boolean) {
  overlayMatches = next
  for (const l of [...listeners]) l()
}

beforeEach(() => {
  overlayMatches = false
  listeners.clear()
  localStorage.clear()
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return overlayMatches
    },
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

let state: ReturnType<typeof useSidebarOpen>
function Harness() {
  state = useSidebarOpen()
  return null
}

describe('useSidebarOpen', () => {
  it('starts open when docked with no stored preference', () => {
    render(<Harness />)
    expect(state.open).toBe(true)
    expect(state.overlay).toBe(false)
  })

  it('honours a stored collapsed preference when docked', () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    render(<Harness />)
    expect(state.open).toBe(false)
  })

  // An overlay covers the transcript, so a remembered "open" would ambush you on
  // every load. It always starts closed regardless of the desktop preference.
  it('starts closed as an overlay even when the desktop preference is open', () => {
    overlayMatches = true
    render(<Harness />)
    expect(state.open).toBe(false)
    expect(state.overlay).toBe(true)
  })

  it('persists the collapse preference when docked', () => {
    render(<Harness />)
    act(() => state.toggle())
    expect(state.open).toBe(false)
    expect(localStorage.getItem('sidebar-collapsed')).toBe('true')
  })

  // The overlay is transient. Flicking it open on a phone must not teach the
  // desktop layout to start collapsed (or vice versa) next time.
  it('does not persist anything when toggled as an overlay', () => {
    overlayMatches = true
    render(<Harness />)
    act(() => state.toggle())
    expect(state.open).toBe(true)
    expect(localStorage.getItem('sidebar-collapsed')).toBeNull()
  })

  it('closes when the viewport narrows into overlay mode', () => {
    render(<Harness />)
    expect(state.open).toBe(true)
    act(() => setOverlay(true))
    expect(state.overlay).toBe(true)
    expect(state.open).toBe(false)
  })

  it('restores the desktop preference when the viewport widens back', () => {
    overlayMatches = true
    render(<Harness />)
    act(() => setOverlay(false))
    expect(state.open).toBe(true)
  })

  it('restores a COLLAPSED desktop preference when widening back', () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    overlayMatches = true
    render(<Harness />)
    act(() => setOverlay(false))
    expect(state.open).toBe(false)
  })

  it('show is idempotent, unlike toggle', () => {
    overlayMatches = true
    render(<Harness />)
    act(() => state.show())
    act(() => state.show())
    expect(state.open).toBe(true)
  })
})
