/**
 * Closing the ORIGINAL is the destructive half of a fork, so the ordering is
 * pinned here: the source only dies once the fork has actually been accepted,
 * and never when the box is unticked.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@/lib/types'
import { useForkAction } from './use-fork-action'

const terminateConversation = vi.fn()
const sendSpawnRequest = vi.fn()

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: { getState: () => ({ terminateConversation }) },
}))
vi.mock('@/hooks/use-spawn', () => ({ sendSpawnRequest: (req: unknown) => sendSpawnRequest(req) }))
vi.mock('./fork-api', () => ({
  forkCcSession: async () => ({ ok: true, resumeId: 'cc-fork-1', stats: null }),
  forkSummary: async () => ({ ok: false, error: 'unused' }),
}))

const SOURCE = {
  id: 'conv_source',
  project: 'claude://default/Users/jonas/projects/repo',
  status: 'idle',
} as Conversation

async function forkThenLaunch(conversation: Conversation, closeOriginal: boolean) {
  const { result } = renderHook(() => useForkAction(conversation))
  await act(async () => {
    await result.current.runFork('compacted', {})
  })
  await act(async () => {
    await result.current.runLaunch({}, closeOriginal)
  })
  return result
}

describe('useForkAction -- close the original', () => {
  beforeEach(() => {
    terminateConversation.mockClear()
    sendSpawnRequest.mockReset()
  })

  it('terminates the source once the fork launched', async () => {
    sendSpawnRequest.mockResolvedValue({ ok: true, conversationId: 'conv_fork' })

    await forkThenLaunch(SOURCE, true)

    expect(terminateConversation).toHaveBeenCalledWith('conv_source', 'dashboard-fork-close-original')
  })

  it('leaves the source alone when the launch FAILED -- never zero conversations', async () => {
    sendSpawnRequest.mockResolvedValue({ ok: false, error: 'no sentinel' })

    const result = await forkThenLaunch(SOURCE, true)

    expect(terminateConversation).not.toHaveBeenCalled()
    // The fold survives, so the launch can be retried.
    expect(result.current.phase).toBe('ready')
  })

  it('leaves the source alone when the box is unticked', async () => {
    sendSpawnRequest.mockResolvedValue({ ok: true, conversationId: 'conv_fork' })

    await forkThenLaunch(SOURCE, false)

    expect(terminateConversation).not.toHaveBeenCalled()
  })

  it('never re-terminates an already-ended source', async () => {
    sendSpawnRequest.mockResolvedValue({ ok: true, conversationId: 'conv_fork' })

    await forkThenLaunch({ ...SOURCE, status: 'ended' } as Conversation, true)

    expect(terminateConversation).not.toHaveBeenCalled()
  })
})
