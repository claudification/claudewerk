import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEdgeSwipe } from './use-edge-swipe'

/** The narrow slice of TouchEvent the hook actually reads. */
const start = (x: number, y = 200) => ({ touches: [{ clientX: x, clientY: y }] }) as unknown as React.TouchEvent
const end = (x: number, y = 200) => ({ changedTouches: [{ clientX: x, clientY: y }] }) as unknown as React.TouchEvent

const W = 400

beforeEach(() => {
  vi.stubGlobal('innerWidth', W)
})

function setup() {
  const onFromLeft = vi.fn()
  const onFromRight = vi.fn()
  const { result } = renderHook(() => useEdgeSwipe({ onFromLeft, onFromRight }))
  const swipe = (from: React.TouchEvent, to: React.TouchEvent) => {
    act(() => result.current.onTouchStart(from))
    act(() => result.current.onTouchEnd(to))
  }
  return { onFromLeft, onFromRight, swipe, result }
}

describe('useEdgeSwipe', () => {
  it('fires the left handler for a left-edge swipe inward', () => {
    const { onFromLeft, onFromRight, swipe } = setup()
    swipe(start(10), end(120))
    expect(onFromLeft).toHaveBeenCalledOnce()
    expect(onFromRight).not.toHaveBeenCalled()
  })

  it('fires the right handler for a right-edge swipe inward', () => {
    const { onFromLeft, onFromRight, swipe } = setup()
    swipe(start(W - 10), end(W - 120))
    expect(onFromRight).toHaveBeenCalledOnce()
    expect(onFromLeft).not.toHaveBeenCalled()
  })

  it('fires nothing for a swipe that starts mid-canvas', () => {
    const { onFromLeft, onFromRight, swipe } = setup()
    swipe(start(200), end(320))
    expect(onFromLeft).not.toHaveBeenCalled()
    expect(onFromRight).not.toHaveBeenCalled()
  })

  it('fires nothing for a tap', () => {
    const { onFromLeft, swipe } = setup()
    swipe(start(10), end(15))
    expect(onFromLeft).not.toHaveBeenCalled()
  })

  it('survives a touchend with no matching touchstart', () => {
    const { onFromLeft, onFromRight, result } = setup()
    act(() => result.current.onTouchEnd(end(120)))
    expect(onFromLeft).not.toHaveBeenCalled()
    expect(onFromRight).not.toHaveBeenCalled()
  })

  it('survives an event with no touch points', () => {
    const { result } = setup()
    expect(() => {
      act(() => result.current.onTouchStart({ touches: [] } as unknown as React.TouchEvent))
      act(() => result.current.onTouchEnd({ changedTouches: [] } as unknown as React.TouchEvent))
    }).not.toThrow()
  })

  it('consumes the start, so a second touchend does not re-fire', () => {
    const { onFromLeft, swipe, result } = setup()
    swipe(start(10), end(120))
    act(() => result.current.onTouchEnd(end(120)))
    expect(onFromLeft).toHaveBeenCalledOnce()
  })

  it('does not require the opposite handler to be supplied', () => {
    const onFromRight = vi.fn()
    const { result } = renderHook(() => useEdgeSwipe({ onFromRight }))
    expect(() => {
      act(() => result.current.onTouchStart(start(10)))
      act(() => result.current.onTouchEnd(end(120)))
    }).not.toThrow()
    expect(onFromRight).not.toHaveBeenCalled()
  })
})
