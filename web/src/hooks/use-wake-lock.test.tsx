import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWakeLock } from './use-wake-lock'

// A fake Screen Wake Lock: request() hands back a sentinel with a release spy,
// and we count requests so re-acquisition is observable.
function fakeWakeLock() {
  const sentinels: Array<{ release: ReturnType<typeof vi.fn> }> = []
  const request = vi.fn(async () => {
    const s = { release: vi.fn(async () => {}) }
    sentinels.push(s)
    return s
  })
  return { api: { request }, request, sentinels }
}

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true })
}

/** Let the async acquire() microtask settle inside act(). */
const flush = () => act(async () => {})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(navigator, 'wakeLock')
  setVisibility('visible')
})
beforeEach(() => setVisibility('visible'))

describe('useWakeLock', () => {
  it('acquires a screen lock while active and releases when active goes false', async () => {
    const wl = fakeWakeLock()
    Object.defineProperty(navigator, 'wakeLock', { value: wl.api, configurable: true })

    const { rerender } = renderHook(({ a }) => useWakeLock(a), { initialProps: { a: true } })
    await flush()
    expect(wl.request).toHaveBeenCalledWith('screen')
    expect(wl.sentinels).toHaveLength(1)

    rerender({ a: false })
    expect(wl.sentinels[0].release).toHaveBeenCalledTimes(1)
  })

  it('releases the lock on unmount', async () => {
    const wl = fakeWakeLock()
    Object.defineProperty(navigator, 'wakeLock', { value: wl.api, configurable: true })

    const { unmount } = renderHook(() => useWakeLock(true))
    await flush()
    expect(wl.sentinels).toHaveLength(1)

    unmount()
    expect(wl.sentinels[0].release).toHaveBeenCalledTimes(1)
  })

  it('re-acquires when the page returns to visible (the platform drops it when hidden)', async () => {
    const wl = fakeWakeLock()
    Object.defineProperty(navigator, 'wakeLock', { value: wl.api, configurable: true })

    renderHook(() => useWakeLock(true))
    await flush()
    expect(wl.request).toHaveBeenCalledTimes(1)

    // Simulate the platform dropping the lock while hidden, then coming back.
    setVisibility('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    setVisibility('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await flush()
    expect(wl.request).toHaveBeenCalledTimes(2)
  })

  it('does not request while active but hidden', async () => {
    const wl = fakeWakeLock()
    Object.defineProperty(navigator, 'wakeLock', { value: wl.api, configurable: true })
    setVisibility('hidden')

    renderHook(() => useWakeLock(true))
    await flush()
    expect(wl.request).not.toHaveBeenCalled()
  })

  it('no-ops without throwing when the API is absent', async () => {
    // navigator.wakeLock is not defined here.
    expect(() => renderHook(() => useWakeLock(true))).not.toThrow()
    await flush()
  })
})
