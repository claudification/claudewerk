import { describe, expect, it } from 'bun:test'
import { DEFAULT_NOTIFY_PARENT_SETTLE_MS } from '../shared/spawn-schema'
import { collectLineageSubtree, resolveNotifyParentSettleMs } from './spawn-lineage'

describe('resolveNotifyParentSettleMs', () => {
  it('is undefined when the caller did not opt in', () => {
    expect(resolveNotifyParentSettleMs({})).toBeUndefined()
    expect(resolveNotifyParentSettleMs({ notifyParent: false, notifyParentSettleMs: 5000 })).toBeUndefined()
  })

  it('defaults to the standard window when opted in without an override', () => {
    expect(resolveNotifyParentSettleMs({ notifyParent: true })).toBe(DEFAULT_NOTIFY_PARENT_SETTLE_MS)
  })

  it('honors a caller-supplied window when opted in', () => {
    expect(resolveNotifyParentSettleMs({ notifyParent: true, notifyParentSettleMs: 45000 })).toBe(45000)
  })
})

type Row = { id: string; parentConversationId?: string | null }

describe('collectLineageSubtree', () => {
  it('returns the root first then descendants in BFS order', () => {
    // A -> B -> C chain
    const rows: Row[] = [{ id: 'A' }, { id: 'B', parentConversationId: 'A' }, { id: 'C', parentConversationId: 'B' }]
    expect(collectLineageSubtree(rows, 'A')).toEqual(['A', 'B', 'C'])
  })

  it('collects only the subtree below the given node', () => {
    const rows: Row[] = [{ id: 'A' }, { id: 'B', parentConversationId: 'A' }, { id: 'C', parentConversationId: 'B' }]
    expect(collectLineageSubtree(rows, 'B')).toEqual(['B', 'C'])
  })

  it('handles fan-out (multiple children per node)', () => {
    const rows: Row[] = [
      { id: 'A' },
      { id: 'B', parentConversationId: 'A' },
      { id: 'C', parentConversationId: 'A' },
      { id: 'D', parentConversationId: 'B' },
    ]
    expect(collectLineageSubtree(rows, 'A').sort()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('always includes the root even when absent from the list', () => {
    expect(collectLineageSubtree([{ id: 'X', parentConversationId: 'A' }], 'A')).toEqual(['A', 'X'])
  })

  it('is cycle-safe (each id visited at most once)', () => {
    const rows: Row[] = [
      { id: 'A', parentConversationId: 'B' },
      { id: 'B', parentConversationId: 'A' },
    ]
    expect(collectLineageSubtree(rows, 'A').sort()).toEqual(['A', 'B'])
  })

  it('ignores unrelated lineages', () => {
    const rows: Row[] = [
      { id: 'A' },
      { id: 'B', parentConversationId: 'A' },
      { id: 'Z' },
      { id: 'Y', parentConversationId: 'Z' },
    ]
    expect(collectLineageSubtree(rows, 'A')).toEqual(['A', 'B'])
  })
})
