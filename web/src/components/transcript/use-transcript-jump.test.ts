/**
 * Transcript-search jump: getting the target entry to EXIST before scrolling.
 *
 * Clicking a search hit used to call selectConversation(id) and throw the hit's
 * seq away -- the transcript opened at the bottom and the user had to find the
 * message themselves. The seq now rides along, but honouring it is not one
 * scroll: the entry may be older than anything loaded (fetch), or loaded but
 * above the render window's boundary (reveal). These pin that state machine,
 * including the two ways it is allowed to give up.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptEntry } from '@/lib/types'
import type { DisplayGroup } from './grouping'
import { requestTranscriptJump, useTranscriptJumpStore } from './transcript-jump-store'
import { useTranscriptJump } from './use-transcript-jump'

const CONV = 'conv_jump'

function entry(seq: number): TranscriptEntry {
  return { seq, uuid: `u${seq}`, type: 'user', timestamp: '2026-08-19T00:00:00.000Z' } as unknown as TranscriptEntry
}

function group(seqs: number[]): DisplayGroup {
  return {
    type: 'user',
    id: `g${seqs[0]}`,
    timestamp: '2026-08-19T00:00:00.000Z',
    entries: seqs.map(entry),
  } as DisplayGroup
}

interface Harness {
  entries: TranscriptEntry[]
  groups: DisplayGroup[]
  hasMoreOlder: boolean
  fetchOlder: ReturnType<typeof vi.fn>
  revealSeq: ReturnType<typeof vi.fn>
  onLeaveFollow: ReturnType<typeof vi.fn>
}

function harness(over: Partial<Harness> = {}): Harness {
  return {
    entries: [entry(100), entry(101), entry(102)],
    groups: [group([100, 101]), group([102])],
    hasMoreOlder: true,
    fetchOlder: vi.fn(),
    revealSeq: vi.fn(),
    onLeaveFollow: vi.fn(),
    ...over,
  }
}

function run(h: Harness) {
  return renderHook(props => useTranscriptJump(props), {
    initialProps: { cacheKey: CONV, ...h },
  })
}

beforeEach(() => {
  useTranscriptJumpStore.getState().clearJump()
})

afterEach(() => {
  useTranscriptJumpStore.getState().clearJump()
  vi.restoreAllMocks()
})

describe('useTranscriptJump', () => {
  it('does nothing at all without a pending jump', () => {
    const h = harness()
    const { result } = run(h)
    expect(result.current.groupKey).toBeNull()
    expect(h.fetchOlder).not.toHaveBeenCalled()
    expect(h.onLeaveFollow).not.toHaveBeenCalled()
  })

  it('ignores a jump aimed at a different conversation', () => {
    const h = harness()
    const { result, rerender } = run(h)
    act(() => requestTranscriptJump('some_other_conv', 101))
    rerender({ cacheKey: CONV, ...h })
    expect(result.current.groupKey).toBeNull()
    expect(h.fetchOlder).not.toHaveBeenCalled()
  })

  it('resolves the group holding the seq when it is already loaded', () => {
    const h = harness()
    const { result, rerender } = run(h)
    act(() => requestTranscriptJump(CONV, 101))
    rerender({ cacheKey: CONV, ...h })
    expect(result.current.groupKey).toBe('g100')
    expect(h.revealSeq).toHaveBeenCalledWith(101)
    expect(h.fetchOlder).not.toHaveBeenCalled()
  })

  it('leaves follow before landing, or the end-pin drags the reader back down', () => {
    const h = harness()
    const { rerender } = run(h)
    act(() => requestTranscriptJump(CONV, 101))
    rerender({ cacheKey: CONV, ...h })
    expect(h.onLeaveFollow).toHaveBeenCalledTimes(1)
  })

  it('fetches older history when the seq is behind the oldest loaded entry', () => {
    const h = harness()
    const { result, rerender } = run(h)
    act(() => requestTranscriptJump(CONV, 12))
    rerender({ cacheKey: CONV, ...h })
    expect(result.current.groupKey).toBeNull()
    expect(h.fetchOlder).toHaveBeenCalledTimes(1)
    expect(h.revealSeq).not.toHaveBeenCalled()
  })

  it('gives up instead of looping when the whole transcript is loaded and the seq is not in it', () => {
    const h = harness({ hasMoreOlder: false })
    const { rerender } = run(h)
    act(() => requestTranscriptJump(CONV, 12))
    rerender({ cacheKey: CONV, ...h })
    expect(h.fetchOlder).not.toHaveBeenCalled()
    expect(useTranscriptJumpStore.getState().jump).toBeNull()
  })

  it('clears the request once the renderer reports it landed', () => {
    const h = harness()
    const { result, rerender } = run(h)
    act(() => requestTranscriptJump(CONV, 101))
    rerender({ cacheKey: CONV, ...h })
    act(() => result.current.onLanded())
    expect(useTranscriptJumpStore.getState().jump).toBeNull()
    expect(result.current.highlightKey).toBe('g100')
  })

  it('drops a pending jump when the transcript unmounts mid-flight', () => {
    const h = harness()
    const { unmount } = run(h)
    act(() => requestTranscriptJump(CONV, 12))
    unmount()
    expect(useTranscriptJumpStore.getState().jump).toBeNull()
  })
})
