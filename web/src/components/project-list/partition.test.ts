import { describe, expect, it } from 'vitest'
import type { Conversation } from '@/lib/types'
import { partitionConversations } from './partition'

function makeConversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 'sess',
    cwd: '/cwd',
    status: 'idle',
    startedAt: 0,
    lastActivity: 0,
    eventCount: 0,
    activeSubagentCount: 0,
    totalSubagentCount: 0,
    subagents: [],
    taskCount: 0,
    pendingTaskCount: 0,
    activeTasks: [],
    pendingTasks: [],
    runningBgTaskCount: 0,
    bgTasks: [],
    teammates: [],
    ...overrides,
  } as Conversation
}

describe('partitionConversations', () => {
  it('returns empty arrays for empty input', () => {
    const result = partitionConversations([])
    expect(result).toEqual({ worktrees: [], adhoc: [], normal: [] })
  })

  it('routes conversations with ad-hoc capability into adhoc bucket', () => {
    const s = makeConversation({ id: 'a', capabilities: ['ad-hoc'] })
    expect(partitionConversations([s])).toEqual({ worktrees: [], adhoc: [s], normal: [] })
  })

  it('routes conversations without ad-hoc capability into normal bucket', () => {
    const s = makeConversation({ id: 'n', capabilities: ['headless'] })
    expect(partitionConversations([s])).toEqual({ worktrees: [], adhoc: [], normal: [s] })
  })

  it('treats missing capabilities as normal (not adhoc)', () => {
    const s = makeConversation({ id: 'm' })
    expect(partitionConversations([s])).toEqual({ worktrees: [], adhoc: [], normal: [s] })
  })

  // Status is not this function's business -- callers hand it rows that are
  // already ended-free. It must not grow an `ended` bucket back.
  it('exposes no ended bucket and routes by capability regardless of status', () => {
    const endedAdhoc = makeConversation({ id: 'ea', status: 'ended', capabilities: ['ad-hoc'] })
    const endedNormal = makeConversation({ id: 'en', status: 'ended' })
    const result = partitionConversations([endedAdhoc, endedNormal])
    expect('ended' in result).toBe(false)
    expect(result.adhoc).toEqual([endedAdhoc])
    expect(result.normal).toEqual([endedNormal])
  })

  it('partitions a mixed group once per conversation (no double-walk)', () => {
    const a1 = makeConversation({ id: 'a1', capabilities: ['ad-hoc'] })
    const a2 = makeConversation({ id: 'a2', capabilities: ['ad-hoc'], status: 'ended' })
    const n1 = makeConversation({ id: 'n1' })
    const n2 = makeConversation({ id: 'n2', status: 'ended' })
    const result = partitionConversations([a1, a2, n1, n2])
    expect(result.adhoc).toEqual([a1, a2])
    expect(result.normal).toEqual([n1, n2])
  })

  it('preserves input order within each bucket', () => {
    const conversations = [
      makeConversation({ id: '1' }),
      makeConversation({ id: '2', capabilities: ['ad-hoc'] }),
      makeConversation({ id: '3' }),
      makeConversation({ id: '4', capabilities: ['ad-hoc'] }),
    ]
    const { adhoc, normal } = partitionConversations(conversations)
    expect(adhoc.map(s => s.id)).toEqual(['2', '4'])
    expect(normal.map(s => s.id)).toEqual(['1', '3'])
  })
})
