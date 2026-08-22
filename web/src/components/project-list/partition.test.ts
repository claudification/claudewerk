/**
 * @vitest-environment node
 */
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
    expect(result).toEqual({ epicGroups: [], worktrees: [], adhoc: [], normal: [] })
  })

  it('routes conversations with ad-hoc capability into adhoc bucket', () => {
    const s = makeConversation({ id: 'a', capabilities: ['ad-hoc'] })
    expect(partitionConversations([s])).toEqual({ epicGroups: [], worktrees: [], adhoc: [s], normal: [] })
  })

  it('routes conversations without ad-hoc capability into normal bucket', () => {
    const s = makeConversation({ id: 'n', capabilities: ['headless'] })
    expect(partitionConversations([s])).toEqual({ epicGroups: [], worktrees: [], adhoc: [], normal: [s] })
  })

  it('treats missing capabilities as normal (not adhoc)', () => {
    const s = makeConversation({ id: 'm' })
    expect(partitionConversations([s])).toEqual({ epicGroups: [], worktrees: [], adhoc: [], normal: [s] })
  })

  // THE REQUIREMENT, in one test: "werk-verifiers and werk-workers always group under
  // the werk-master, WHETHER THEY ARE AD HOC OR NOT". Every seat below is ad-hoc,
  // and one is in a worktree -- neither may pull it out of its subtree.
  it('nests seats under their werk-master even when ad-hoc and in a worktree', () => {
    const tag = (role: 'werk-master' | 'werk-worker' | 'werk-verifier', epicId = 'epic-the-wall') => ({
      epic: { epicId, role, gen: 11 },
      capabilities: ['ad-hoc'],
    })
    const werkMaster = makeConversation({ id: 'ov', startedAt: 1, ...tag('werk-master') })
    const impl = makeConversation({
      id: 'im',
      startedAt: 2,
      project: 'claude:///p/.claude/worktrees/wall-now-bar',
      ...tag('werk-worker'),
    })
    const verify = makeConversation({ id: 've', startedAt: 3, ...tag('werk-verifier') })
    const plain = makeConversation({ id: 'pl', startedAt: 4 })

    const result = partitionConversations([werkMaster, impl, verify, plain])

    expect(result.epicGroups).toHaveLength(1)
    expect(result.epicGroups[0].werkMaster?.id).toBe('ov')
    expect(result.epicGroups[0].seats.map(s => s.id)).toEqual(['im', 've'])
    // and none of them leaked into the buckets that would have claimed them
    expect(result.adhoc).toEqual([])
    expect(result.worktrees).toEqual([])
    expect(result.normal).toEqual([plain])
  })

  // Two epic cards in one project each hold their own werk-master lease today, so
  // one project genuinely can show two subtrees. Merging them would invent a
  // run that does not exist.
  it('keeps two epics in one project as two subtrees', () => {
    const seat = (id: string, epicId: string) =>
      makeConversation({ id, startedAt: 1, epic: { epicId, role: 'werk-worker', gen: 1 } })
    const result = partitionConversations([seat('a', 'epic-the-wall'), seat('b', 'epic-the-wall-ii')])
    expect(result.epicGroups).toHaveLength(2)
  })

  // A werk-master whose generation ended leaves its seats headless. They must
  // still group, and still render (flat) rather than vanish or indent under
  // nothing -- the same degradation lineage.ts already does for a dead root.
  it('groups headless seats with no werk-master present', () => {
    const orphan = makeConversation({ id: 'o1', startedAt: 1, epic: { epicId: 'e', role: 'werk-worker', gen: 9 } })
    const result = partitionConversations([orphan])
    expect(result.epicGroups).toHaveLength(1)
    expect(result.epicGroups[0].werkMaster).toBeUndefined()
    expect(result.epicGroups[0].seats.map(s => s.id)).toEqual(['o1'])
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
