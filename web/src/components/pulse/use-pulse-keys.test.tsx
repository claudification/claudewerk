import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PulseRow } from './use-pulse-fleet'
import { usePulseKeys } from './use-pulse-keys'

afterEach(cleanup)

function row(id: string): PulseRow {
  return {
    id,
    conversation: { id } as PulseRow['conversation'],
    band: 'needs',
    title: id,
    project: 'remote-claude',
    action: 'waiting',
    ageMs: 1_000,
  }
}

/** Minimal stand-in for the React keyboard event the surface forwards. */
function key(k: string) {
  return { key: k, preventDefault: vi.fn() } as unknown as React.KeyboardEvent
}

describe('usePulseKeys', () => {
  it('preselects the first row — which is the oldest NEEDS YOU, i.e. the fire', () => {
    const rows = [row('a'), row('b'), row('c')]
    const { result } = renderHook(() => usePulseKeys(rows, vi.fn()))
    expect(result.current.activeId).toBe('a')
  })

  it('is null with no rows', () => {
    const { result } = renderHook(() => usePulseKeys([], vi.fn()))
    expect(result.current.activeId).toBeNull()
  })

  it('moves down and up', () => {
    const rows = [row('a'), row('b'), row('c')]
    const { result } = renderHook(() => usePulseKeys(rows, vi.fn()))
    act(() => result.current.handleKeyDown(key('ArrowDown')))
    expect(result.current.activeId).toBe('b')
    act(() => result.current.handleKeyDown(key('ArrowUp')))
    expect(result.current.activeId).toBe('a')
  })

  it('clamps at both ends rather than wrapping', () => {
    const rows = [row('a'), row('b')]
    const { result } = renderHook(() => usePulseKeys(rows, vi.fn()))
    act(() => result.current.handleKeyDown(key('ArrowUp')))
    expect(result.current.activeId).toBe('a')
    act(() => result.current.handleKeyDown(key('ArrowDown')))
    act(() => result.current.handleKeyDown(key('ArrowDown')))
    expect(result.current.activeId).toBe('b')
  })

  it('opens the active row on Enter', () => {
    const onOpen = vi.fn()
    const rows = [row('a'), row('b')]
    const { result } = renderHook(() => usePulseKeys(rows, onOpen))
    act(() => result.current.handleKeyDown(key('ArrowDown')))
    act(() => result.current.handleKeyDown(key('Enter')))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
  })

  it('opens the preselected row on a blind Enter', () => {
    const onOpen = vi.fn()
    const { result } = renderHook(() => usePulseKeys([row('a')], onOpen))
    act(() => result.current.handleKeyDown(key('Enter')))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
  })

  it('does nothing on Enter with an empty list', () => {
    const onOpen = vi.fn()
    const { result } = renderHook(() => usePulseKeys([], onOpen))
    act(() => result.current.handleKeyDown(key('Enter')))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('KEEPS the selected conversation when rows re-sort under it', () => {
    // Ages tick and statuses flip constantly; holding an INDEX would silently
    // slide the cursor onto a different conversation.
    const rows = [row('a'), row('b'), row('c')]
    const { result, rerender } = renderHook(({ r }) => usePulseKeys(r, vi.fn()), {
      initialProps: { r: rows },
    })
    act(() => result.current.handleKeyDown(key('ArrowDown')))
    expect(result.current.activeId).toBe('b')
    rerender({ r: [row('c'), row('b'), row('a')] })
    expect(result.current.activeId).toBe('b')
  })

  it('falls back to the first row when the selected one is filtered away', () => {
    const { result, rerender } = renderHook(({ r }) => usePulseKeys(r, vi.fn()), {
      initialProps: { r: [row('a'), row('b')] },
    })
    act(() => result.current.handleKeyDown(key('ArrowDown')))
    expect(result.current.activeId).toBe('b')
    rerender({ r: [row('a')] })
    expect(result.current.activeId).toBe('a')
  })

  it('ignores unrelated keys', () => {
    const onOpen = vi.fn()
    const { result } = renderHook(() => usePulseKeys([row('a'), row('b')], onOpen))
    act(() => result.current.handleKeyDown(key('x')))
    expect(result.current.activeId).toBe('a')
    expect(onOpen).not.toHaveBeenCalled()
  })
})
