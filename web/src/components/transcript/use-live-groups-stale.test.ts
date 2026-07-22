/**
 * The queued-badge idle reap: `idle => nothing queued`.
 *
 * Guards the two things that make this correct rather than merely plausible --
 * that a legitimately-queued message is NOT cleared while a turn is running,
 * and that a cleared ghost does not resurrect when the next turn starts.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DisplayGroup } from './grouping'
import { useLiveGroups } from './use-transcript-derivations'

const CONV = 'conv-1'

let active = false
let streaming = false

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: (selector: (s: unknown) => unknown) =>
    selector({
      conversationsById: { [CONV]: { status: active ? 'active' : 'idle' } },
      streamingText: streaming ? { [CONV]: 'x' } : {},
      streamingThinking: {},
    }),
}))

function queuedGroup(seq: number, text: string): DisplayGroup {
  return {
    type: 'user',
    timestamp: `2026-07-22T05:00:0${seq}.000Z`,
    entries: [{ type: 'user', seq, message: { role: 'user', content: text } } as never],
    queued: true,
  } as DisplayGroup
}

beforeEach(() => {
  vi.useFakeTimers()
  active = false
  streaming = false
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useLiveGroups - stale queued reap', () => {
  it('keeps the badge while a turn is running, however long it runs', () => {
    active = true
    const groups = [queuedGroup(1, 'still waiting')]
    const { result } = renderHook(() => useLiveGroups(groups, CONV))

    expect(result.current.queuedGroups).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    // A genuinely queued message can sit for the whole turn -- that is the
    // feature, not a bug to clean up.
    expect(result.current.queuedGroups).toHaveLength(1)
  })

  it('clears the badge once the conversation has been idle past the debounce', () => {
    const groups = [queuedGroup(1, 'orphaned')]
    const { result } = renderHook(() => useLiveGroups(groups, CONV))

    expect(result.current.queuedGroups).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(4000)
    })

    expect(result.current.queuedGroups).toHaveLength(0)
    expect(result.current.mainGroups).toHaveLength(1)
    expect(result.current.mainGroups[0].queued).toBe(false)
  })

  it('does not clear before the debounce elapses', () => {
    const groups = [queuedGroup(1, 'orphaned')]
    const { result } = renderHook(() => useLiveGroups(groups, CONV))

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(result.current.queuedGroups).toHaveLength(1)
  })

  it('does NOT resurrect the ghost when the next turn starts', () => {
    // The trap in any non-sticky clear: the grouping cache still holds
    // queued:true, so a clear keyed only on the current idle state pops back
    // the moment liveActive flips.
    const groups = [queuedGroup(1, 'orphaned')]
    const { result, rerender } = renderHook(() => useLiveGroups(groups, CONV))

    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(result.current.queuedGroups).toHaveLength(0)

    active = true
    rerender()

    expect(result.current.queuedGroups).toHaveLength(0)
    expect(result.current.mainGroups[0].queued).toBe(false)
  })

  it('leaves the cache-owned group object untouched (React #300)', () => {
    const groups = [queuedGroup(1, 'orphaned')]
    const { result } = renderHook(() => useLiveGroups(groups, CONV))

    act(() => {
      vi.advanceTimersByTime(4000)
    })

    expect(groups[0].queued).toBe(true)
    expect(result.current.mainGroups[0]).not.toBe(groups[0])
  })

  it('a turn starting before the debounce fires cancels the reap', () => {
    const groups = [queuedGroup(1, 'legit')]
    const { result, rerender } = renderHook(() => useLiveGroups(groups, CONV))

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    active = true
    rerender()
    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    expect(result.current.queuedGroups).toHaveLength(1)
  })

  it('clears every stale group when several are queued', () => {
    const groups = [queuedGroup(1, 'a'), queuedGroup(2, 'b')]
    const { result } = renderHook(() => useLiveGroups(groups, CONV))

    expect(result.current.queuedGroups).toHaveLength(2)

    act(() => {
      vi.advanceTimersByTime(4000)
    })

    expect(result.current.queuedGroups).toHaveLength(0)
    expect(result.current.mainGroups.every(g => !g.queued)).toBe(true)
  })
})
