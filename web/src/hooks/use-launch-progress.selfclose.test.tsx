/**
 * REGRESSION: the Launch dialog closed itself the instant it opened.
 *
 * `effectiveWrapperId` falls back to the CURRENT conversation when no launch is
 * in flight (`launch.conversationId || externalWrapperId`). Every caller passes
 * the conversation the user is looking at, so before anything is launched the
 * hook looked that conversation up, found it alive, and reported
 * `isConnected: true` -- "the spawned conversation connected!" about the
 * conversation you were already in.
 *
 * Consumers act on that: RunTaskDialog's "done is done" effect calls onClose on
 * mount, so the dialog unmounted before it ever painted. Clicking Launch did
 * visibly nothing.
 *
 * The contract this pins: a progress tracker that is DISABLED, or that has no
 * job in flight, is not connected to anything. `enabled` is the caller saying
 * "I have not launched yet" -- it must suppress the derived launch state, not
 * just the timeout timer.
 */

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const CURRENT_CONVERSATION = { id: 'conv-current', status: 'active', connectionIds: [] as string[] }

vi.mock('./use-launch-channel', () => ({
  useLaunchChannel: () => ({ conversationId: null, events: [], completed: false, failed: false, error: null }),
}))

vi.mock('@/lib/slim-conversation', () => ({
  selectConversations: (byId: Record<string, unknown>) => Object.values(byId),
}))

vi.mock('./use-conversations', () => ({
  useConversationsStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ conversationsById: { 'conv-current': CURRENT_CONVERSATION } }),
    { getState: () => ({ conversationsById: { 'conv-current': CURRENT_CONVERSATION } }) },
  ),
}))

let useLaunchProgress: typeof import('./use-launch-progress').useLaunchProgress

beforeEach(async () => {
  ;({ useLaunchProgress } = await import('./use-launch-progress'))
})

describe('a tracker with nothing in flight is not "connected"', () => {
  it('reports isConnected=false when disabled and no job has started', () => {
    const { result } = renderHook(() =>
      useLaunchProgress({ jobId: null, conversationId: 'conv-current', enabled: false }),
    )
    expect(result.current.isConnected).toBe(false)
  })

  it('does not mistake the conversation you are viewing for a spawned one', () => {
    const { result } = renderHook(() =>
      useLaunchProgress({ jobId: null, conversationId: 'conv-current', enabled: false }),
    )
    expect(result.current.spawnedConversation).toBeNull()
  })

  it('stays disconnected even when enabled, while no job id exists yet', () => {
    const { result } = renderHook(() =>
      useLaunchProgress({ jobId: null, conversationId: 'conv-current', enabled: true }),
    )
    expect(result.current.isConnected).toBe(false)
  })

  it('reports isRunning=false with nothing launched', () => {
    const { result } = renderHook(() =>
      useLaunchProgress({ jobId: null, conversationId: 'conv-current', enabled: false }),
    )
    expect(result.current.isRunning).toBe(false)
  })

  it('reports isComplete=false with nothing launched', () => {
    const { result } = renderHook(() =>
      useLaunchProgress({ jobId: null, conversationId: 'conv-current', enabled: false }),
    )
    expect(result.current.isComplete).toBe(false)
  })
})

describe('once a launch is actually in flight', () => {
  it('tracks the conversation the launch reports, not the one passed in', () => {
    const { result } = renderHook(() =>
      useLaunchProgress({ jobId: 'job-1', conversationId: 'conv-current', enabled: true }),
    )
    // The mocked channel reports no conversation yet, so still nothing.
    expect(result.current.isConnected).toBe(false)
  })
})
