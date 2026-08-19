/**
 * useWallChannel: the mount/unmount contract THE WALL's panes rely on.
 *
 * Ten panes mounting must put ONE `channel_subscribe` on the wire, and the last
 * one unmounting must put exactly one `channel_unsubscribe` there -- that
 * unsubscribe is what makes the broker stop doing work for a wall nobody is
 * looking at.
 */

import type { WallFrame } from '@shared/wall'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const sent: Array<{ type: string; rest: Record<string, unknown> }> = []
vi.mock('./use-conversations', () => ({
  wsSend: (type: string, rest?: Record<string, unknown>) => {
    sent.push({ type, rest: rest ?? {} })
    return true
  },
}))

const { useWallChannel } = await import('./use-wall-channel')
const { applyWallFrame, resetWallFrames } = await import('./wall-frame-store')
const { resetWallSubscription } = await import('./wall-subscription')

function frame(over: Partial<WallFrame> = {}): WallFrame {
  return { type: 'wall_frame', seq: 1, at: 1, full: true, coalesced: 1, ...over }
}

beforeEach(() => {
  sent.length = 0
  resetWallSubscription()
  resetWallFrames()
})

afterEach(cleanup)

describe('useWallChannel', () => {
  test('subscribes on mount and unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useWallChannel())
    expect(sent.map(m => m.type)).toEqual(['channel_subscribe'])
    expect(sent[0]?.rest.channel).toBe('wall')

    unmount()
    expect(sent.map(m => m.type)).toEqual(['channel_subscribe', 'channel_unsubscribe'])
  })

  test('ten panes still mean ONE subscription on the wire', () => {
    const panes = Array.from({ length: 10 }, () => renderHook(() => useWallChannel()))
    expect(sent.filter(m => m.type === 'channel_subscribe')).toHaveLength(1)

    for (const p of panes.slice(0, 9)) p.unmount()
    expect(sent.filter(m => m.type === 'channel_unsubscribe')).toHaveLength(0)

    panes[9]?.unmount()
    expect(sent.filter(m => m.type === 'channel_unsubscribe')).toHaveLength(1)
  })

  test('re-renders with the applied frame', () => {
    const { result } = renderHook(() => useWallChannel())
    expect(result.current.pulse).toHaveLength(0)

    act(() => {
      applyWallFrame(
        frame({
          pulse: {
            changed: [{ id: 'a', project: 'claude://default/p', title: 'a', status: 'active', lastActivity: 1 }],
          },
        }),
      )
    })
    expect(result.current.pulse.map(r => r.id)).toEqual(['a'])
  })
})
