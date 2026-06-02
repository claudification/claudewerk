import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createLazyBus } from './lazy-bus'

describe('createLazyBus', () => {
  it('dispatches directly when a handler is registered', () => {
    const bus = createLazyBus<number>()
    const handler = vi.fn()
    bus.setHandler(handler)
    bus.open(42)
    expect(handler).toHaveBeenCalledExactlyOnceWith(42)
  })

  it('buffers an open made before mount and replays it on setHandler', () => {
    const bus = createLazyBus<string>()
    bus.open('pending') // no handler yet -> buffered
    const handler = vi.fn()
    bus.setHandler(handler) // mount -> replay
    expect(handler).toHaveBeenCalledExactlyOnceWith('pending')
  })

  it('retains only the latest buffered open', () => {
    const bus = createLazyBus<string>()
    bus.open('first')
    bus.open('second')
    const handler = vi.fn()
    bus.setHandler(handler)
    expect(handler).toHaveBeenCalledExactlyOnceWith('second')
  })

  it('does not replay a buffered open twice', () => {
    const bus = createLazyBus<number>()
    bus.open(1)
    const handler = vi.fn()
    bus.setHandler(handler)
    bus.setHandler(null)
    bus.setHandler(handler)
    expect(handler).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('useArmed starts false and flips true on the first pre-mount open', () => {
    const bus = createLazyBus<number>()
    const { result } = renderHook(() => bus.useArmed())
    expect(result.current).toBe(false)
    act(() => {
      bus.open(7)
    })
    expect(result.current).toBe(true)
  })
})
