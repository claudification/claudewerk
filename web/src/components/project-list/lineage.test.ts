import { describe, expect, it } from 'vitest'
import type { Conversation } from '@/lib/types'
import {
  collectLineageSubtree,
  groupByLineage,
  hasLineageDescendants,
  lineageKey,
  neededOrphanRootIds,
} from './lineage'

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

// collectLineageSubtree / hasLineageDescendants need parent + status, so a
// richer (still partial) fixture.
function node(
  id: string,
  parentConversationId: string | undefined,
  startedAt: number,
  status: Conversation['status'] = 'active',
): Conversation {
  return { id, parentConversationId, startedAt, status } as unknown as Conversation
}

describe('hasLineageDescendants', () => {
  it('is true only when a conversation has at least one direct child', () => {
    const list = [node('A', undefined, 1), node('B', 'A', 2)]
    expect(hasLineageDescendants(list, 'A')).toBe(true)
    expect(hasLineageDescendants(list, 'B')).toBe(false)
    expect(hasLineageDescendants(list, 'missing')).toBe(false)
  })
})

describe('collectLineageSubtree', () => {
  it('returns the target first then descendants in BFS order with depth', () => {
    // A -> B -> C  (a chain, like the punk-scorpion screenshot)
    const list = [node('A', undefined, 1), node('B', 'A', 2), node('C', 'B', 3)]
    const sub = collectLineageSubtree(list, 'A')
    expect(sub.map(m => [m.conversation.id, m.depth])).toEqual([
      ['A', 0],
      ['B', 1],
      ['C', 2],
    ])
  })

  it('collects only the clicked node and below (subtree, not whole tree)', () => {
    const list = [node('A', undefined, 1), node('B', 'A', 2), node('C', 'B', 3)]
    const sub = collectLineageSubtree(list, 'B')
    expect(sub.map(m => m.conversation.id)).toEqual(['B', 'C'])
  })

  it('orders siblings by startedAt and flags active vs ended', () => {
    const list = [node('A', undefined, 1), node('Y', 'A', 30, 'ended'), node('X', 'A', 20, 'active')]
    const sub = collectLineageSubtree(list, 'A')
    expect(sub.map(m => [m.conversation.id, m.isActive])).toEqual([
      ['A', true],
      ['X', true],
      ['Y', false],
    ])
  })

  it('is cycle-safe and visits each conversation at most once', () => {
    // Pathological self/loop parent pointers must not hang.
    const list = [node('A', 'B', 1), node('B', 'A', 2)]
    const sub = collectLineageSubtree(list, 'A')
    expect(sub.map(m => m.conversation.id).sort()).toEqual(['A', 'B'])
  })

  it('returns nothing when the target is absent', () => {
    expect(collectLineageSubtree([node('A', undefined, 1)], 'missing')).toEqual([])
  })
})
