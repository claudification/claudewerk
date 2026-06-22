/**
 * Tests for the revive_result handler persisting the re-resolved profile.
 *
 * Bug: spawn on profile A -> terminate -> revive on profile B. It RUNS on B
 * but REPORTED A everywhere (UI, list_conversations) because the broker's
 * reviveResult handler dropped the `resolvedProfile` the sentinel echoes back.
 * The spawn path captures it (setPendingResolvedProfile -> boot); revive had no
 * equivalent. Fix: overwrite conv.resolvedProfile from revive_result and
 * re-broadcast. 'default' clears back to undefined; absent leaves it unchanged.
 */

import { describe, expect, it } from 'bun:test'
import type { HandlerContext } from '../handler-context'
import { reviveResult } from './sentinel'

interface MockConversation {
  id: string
  project: string
  resolvedProfile?: string
}

function makeCtx(conversation: MockConversation | undefined) {
  const updates: string[] = []
  const broadcasts: Record<string, unknown>[] = []
  const failedJobs: Array<{ jobId: string; error: string }> = []
  const ctx = {
    conversations: {
      getConversation: (id: string) => (conversation && conversation.id === id ? conversation : undefined),
      broadcastConversationUpdate: (id: string) => updates.push(id),
      failJob: (jobId: string, error: string) => failedJobs.push({ jobId, error }),
    },
    broadcastScoped: (msg: Record<string, unknown>) => broadcasts.push(msg),
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  return { ctx, updates, broadcasts, failedJobs, conversation }
}

describe('revive_result resolvedProfile persistence', () => {
  it('overwrites conv.resolvedProfile A -> B and re-broadcasts', () => {
    const conv: MockConversation = { id: 'conv_x', project: 'claude:///p', resolvedProfile: 'A' }
    const { ctx, updates } = makeCtx(conv)
    reviveResult(ctx, {
      type: 'revive_result',
      ccSessionId: 'cc123456',
      conversationId: 'conv_x',
      success: true,
      continued: true,
      resolvedProfile: 'B',
    })
    expect(conv.resolvedProfile).toBe('B')
    expect(updates).toEqual(['conv_x'])
  })

  it("maps the literal 'default' back to undefined (clear to default)", () => {
    const conv: MockConversation = { id: 'conv_x', project: 'claude:///p', resolvedProfile: 'A' }
    const { ctx, updates } = makeCtx(conv)
    reviveResult(ctx, {
      type: 'revive_result',
      ccSessionId: 'cc123456',
      conversationId: 'conv_x',
      success: true,
      continued: true,
      resolvedProfile: 'default',
    })
    expect(conv.resolvedProfile).toBeUndefined()
    expect(updates).toEqual(['conv_x'])
  })

  it('leaves resolvedProfile unchanged when the field is absent (un-rebuilt sentinel)', () => {
    const conv: MockConversation = { id: 'conv_x', project: 'claude:///p', resolvedProfile: 'A' }
    const { ctx, updates } = makeCtx(conv)
    reviveResult(ctx, {
      type: 'revive_result',
      ccSessionId: 'cc123456',
      conversationId: 'conv_x',
      success: true,
      continued: true,
    })
    expect(conv.resolvedProfile).toBe('A')
    expect(updates).toEqual([])
  })

  it('does NOT persist on a failed revive', () => {
    const conv: MockConversation = { id: 'conv_x', project: 'claude:///p', resolvedProfile: 'A' }
    const { ctx, updates, failedJobs } = makeCtx(conv)
    reviveResult(ctx, {
      type: 'revive_result',
      ccSessionId: 'cc123456',
      conversationId: 'conv_x',
      jobId: 'job1',
      success: false,
      continued: false,
      error: 'boom',
      resolvedProfile: 'B',
    })
    expect(conv.resolvedProfile).toBe('A')
    expect(updates).toEqual([])
    expect(failedJobs).toEqual([{ jobId: 'job1', error: 'boom' }])
  })

  it('does not re-broadcast when the resolved profile is unchanged', () => {
    const conv: MockConversation = { id: 'conv_x', project: 'claude:///p', resolvedProfile: 'B' }
    const { ctx, updates } = makeCtx(conv)
    reviveResult(ctx, {
      type: 'revive_result',
      ccSessionId: 'cc123456',
      conversationId: 'conv_x',
      success: true,
      continued: true,
      resolvedProfile: 'B',
    })
    expect(conv.resolvedProfile).toBe('B')
    expect(updates).toEqual([])
  })
})
