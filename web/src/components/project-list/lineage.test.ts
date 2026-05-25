import { describe, expect, it } from 'vitest'
import type { Conversation } from '@/lib/types'
import { groupByLineage, lineageKey, neededOrphanRootIds } from './lineage'

// groupByLineage only reads id / startedAt / rootConversationId, so a tiny
// partial cast keeps the fixtures legible.
function conv(id: string, startedAt: number, rootConversationId?: string): Conversation {
  return { id, startedAt, rootConversationId } as unknown as Conversation
}

describe('lineageKey', () => {
  it('is the root id when set, else the conversation id', () => {
    expect(lineageKey(conv('A', 1))).toBe('A')
    expect(lineageKey(conv('B', 2, 'A'))).toBe('A')
  })
})

describe('neededOrphanRootIds', () => {
  it('returns roots referenced but not present', () => {
    const list = [conv('B', 2, 'A'), conv('C', 3, 'A')]
    expect(neededOrphanRootIds(list)).toEqual(['A'])
  })

  it('returns nothing when the root is present', () => {
    const list = [conv('A', 1), conv('B', 2, 'A')]
    expect(neededOrphanRootIds(list)).toEqual([])
  })
})

describe('groupByLineage', () => {
  it('keeps an ungrouped conversation as a single root member', () => {
    const groups = groupByLineage([conv('A', 1)])
    expect(groups).toHaveLength(1)
    expect(groups[0].members).toEqual([{ conversation: expect.objectContaining({ id: 'A' }), role: 'root' }])
  })

  it('orders root first, then descendants by startedAt ascending', () => {
    // A (root) -> B -> C, all present, list arrives newest-first.
    const A = conv('A', 1)
    const B = conv('B', 2, 'A')
    const C = conv('C', 3, 'A')
    const groups = groupByLineage([C, B, A])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('A')
    expect(groups[0].members.map(m => [m.conversation.id, m.role])).toEqual([
      ['A', 'root'],
      ['B', 'child'],
      ['C', 'child'],
    ])
  })

  it('pulls an absent root in as a dimmed orphan at the top of the group', () => {
    const B = conv('B', 2, 'A')
    const C = conv('C', 3, 'A')
    const A = conv('A', 1) // ended/filtered -> provided via orphanRoots
    const groups = groupByLineage([B, C], [A])
    expect(groups).toHaveLength(1)
    expect(groups[0].members.map(m => [m.conversation.id, m.role, !!m.orphanRoot])).toEqual([
      ['A', 'root', true],
      ['B', 'child', false],
      ['C', 'child', false],
    ])
  })

  it('renders surviving descendants flat when the root is deleted (no orphan available)', () => {
    const B = conv('B', 2, 'A')
    const C = conv('C', 3, 'A')
    const groups = groupByLineage([B, C], [])
    expect(groups).toHaveLength(1)
    // No resolvable root -> both render as 'root' (no dangling indent).
    expect(groups[0].members.map(m => [m.conversation.id, m.role])).toEqual([
      ['B', 'root'],
      ['C', 'root'],
    ])
  })

  it('separates independent lineages and orders groups newest-first', () => {
    const A = conv('A', 10)
    const B = conv('B', 11, 'A')
    const X = conv('X', 50) // unrelated, newer
    const groups = groupByLineage([A, B, X])
    expect(groups.map(g => g.key)).toEqual(['X', 'A'])
    expect(groups[1].members.map(m => m.conversation.id)).toEqual(['A', 'B'])
  })
})
