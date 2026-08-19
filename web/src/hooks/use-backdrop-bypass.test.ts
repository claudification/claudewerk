import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BYPASS_ATTR, useBackdropBypass } from './use-backdrop-bypass'

const HOLD = 2000
const root = () => document.documentElement
const bypassed = () => root().getAttribute(BYPASS_ATTR) === 'on'

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ...init }))
  })
const release = (key: string) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key }))
  })
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })

describe('useBackdropBypass', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    /* The hook listens on `window`, so a hook left mounted by an earlier test
       keeps reacting to these synthetic key events and engages the bypass on
       somebody else's assertion. Unmount everything between tests. */
    cleanup()
    vi.useRealTimers()
    root().removeAttribute(BYPASS_ATTR)
  })

  it('engages after the full hold', () => {
    renderHook(() => useBackdropBypass())
    press('Alt')
    expect(bypassed()).toBe(false)
    wait(HOLD)
    expect(bypassed()).toBe(true)
  })

  it('does not engage early', () => {
    renderHook(() => useBackdropBypass())
    press('Alt')
    wait(HOLD - 1)
    expect(bypassed()).toBe(false)
  })

  it('releases when Option comes up', () => {
    renderHook(() => useBackdropBypass())
    press('Alt')
    wait(HOLD)
    release('Alt')
    expect(bypassed()).toBe(false)
  })

  it('does not steal Option from a chord', () => {
    // Opt+Enter must keep working: the other key cancels the pending hold.
    renderHook(() => useBackdropBypass())
    press('Alt')
    press('Enter', { altKey: true })
    wait(HOLD * 2)
    expect(bypassed()).toBe(false)
  })

  it('ignores auto-repeat so the hold is armed exactly once', () => {
    renderHook(() => useBackdropBypass())
    press('Alt')
    wait(HOLD / 2)
    press('Alt', { repeat: true })
    wait(HOLD / 2)
    expect(bypassed()).toBe(true)
  })

  it('drops the bypass when the window loses focus', () => {
    // Option-Tab away and the keyup never arrives -- without this the app
    // would be left permanently see-through.
    renderHook(() => useBackdropBypass())
    press('Alt')
    wait(HOLD)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(bypassed()).toBe(false)
  })

  it('cleans up on unmount', () => {
    const { unmount } = renderHook(() => useBackdropBypass())
    press('Alt')
    wait(HOLD)
    unmount()
    expect(bypassed()).toBe(false)
    press('Alt')
    wait(HOLD)
    expect(bypassed()).toBe(false)
  })
})
