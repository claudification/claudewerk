import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoverCard } from './hover-card'
import { computeHoverCoords } from './hover-card-position'

function renderCard(props: Partial<Parameters<typeof HoverCard>[0]> = {}) {
  return render(
    <HoverCard panel={() => <div>PANEL BODY</div>} {...props}>
      <span data-testid="trigger">trigger</span>
    </HoverCard>,
  )
}

const trigger = () => screen.getByTestId('trigger').parentElement as HTMLElement

describe('computeHoverCoords', () => {
  const viewport = { width: 1000, height: 800 }

  it('anchors below the trigger when there is room', () => {
    const c = computeHoverCoords({ left: 100, top: 100, bottom: 120 }, viewport)
    expect(c.top).toBe(126)
    expect(c.bottom).toBeUndefined()
    expect(c.left).toBe(100)
  })

  it('flips above when below is cramped and above has more room', () => {
    const c = computeHoverCoords({ left: 100, top: 700, bottom: 720 }, viewport)
    expect(c.top).toBeUndefined()
    expect(c.bottom).toBe(800 - 700 + 6)
    expect(c.maxHeight).toBeLessThan(700)
  })

  it('clamps left so a right-edge trigger cannot push the panel off-screen', () => {
    const c = computeHoverCoords({ left: 980, top: 10, bottom: 30 }, viewport, 340)
    expect(c.left).toBe(1000 - 340 - 8)
  })
})

describe('HoverCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('opens only after the deliberate delay', () => {
    renderCard()
    fireEvent.mouseEnter(trigger())
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(screen.queryByText('PANEL BODY')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(screen.getByText('PANEL BODY')).toBeTruthy()
  })

  it('does not open when the pointer leaves before the delay elapses', () => {
    renderCard()
    fireEvent.mouseEnter(trigger())
    fireEvent.mouseLeave(trigger())
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.queryByText('PANEL BODY')).toBeNull()
  })

  it('survives the pointer travelling from trigger to panel', () => {
    renderCard()
    fireEvent.mouseEnter(trigger())
    act(() => {
      vi.advanceTimersByTime(600)
    })
    const panel = screen.getByRole('tooltip')
    fireEvent.mouseLeave(trigger())
    fireEvent.mouseEnter(panel)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByText('PANEL BODY')).toBeTruthy()
  })

  it('closes on Escape and on scroll', () => {
    renderCard()
    fireEvent.mouseEnter(trigger())
    act(() => {
      vi.advanceTimersByTime(600)
    })
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(screen.queryByText('PANEL BODY')).toBeNull()

    fireEvent.mouseEnter(trigger())
    act(() => {
      vi.advanceTimersByTime(600)
    })
    act(() => {
      fireEvent.scroll(window)
    })
    expect(screen.queryByText('PANEL BODY')).toBeNull()
  })

  it('never builds the panel while it is shut', () => {
    const panel = vi.fn(() => <div>PANEL BODY</div>)
    renderCard({ panel })
    expect(panel).not.toHaveBeenCalled()
    fireEvent.mouseEnter(trigger())
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(panel).toHaveBeenCalled()
  })

  it('openOnTap toggles on click and swallows the click from the row underneath', () => {
    const onRowClick = vi.fn()
    render(
      // biome-ignore lint/a11y/useKeyWithClickEvents: stand-in for a clickable list row
      <div onClick={onRowClick}>
        <HoverCard panel={() => <div>PANEL BODY</div>} openOnTap>
          <span data-testid="trigger">i</span>
        </HoverCard>
      </div>,
    )
    act(() => {
      fireEvent.click(trigger())
    })
    expect(screen.getByText('PANEL BODY')).toBeTruthy()
    expect(onRowClick).not.toHaveBeenCalled()

    act(() => {
      fireEvent.click(trigger())
    })
    expect(screen.queryByText('PANEL BODY')).toBeNull()
  })

  it('openOnTap dismisses on an outside tap', () => {
    renderCard({ openOnTap: true })
    act(() => {
      fireEvent.click(trigger())
    })
    expect(screen.getByText('PANEL BODY')).toBeTruthy()
    act(() => {
      fireEvent.pointerDown(document.body)
    })
    expect(screen.queryByText('PANEL BODY')).toBeNull()
  })
})
