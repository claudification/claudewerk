/**
 * Regression test for the "Edit diffs re-render on every transcript row" bug.
 *
 * Root cause: the virtualizer keyed each group's wrapper <div> on the group's
 * TAIL entry seq (stableGroupKey). The active (last) group grows at its tail on
 * every streamed entry, so its key changed every tick -> React unmounted +
 * remounted the whole group subtree -> every DiffView/EditDiff was a FRESH mount
 * (useState reset, Shiki re-tokenize, EditDiff useMemo recompute). `memo` and
 * patchesEqual are powerless against a remount -- they guard a preserved
 * instance, not a new one.
 *
 * Fix: each group carries a stable `id` (assignGroupIds), reconciled across
 * regroups so it survives BOTH a tail-append AND a head-prune/prepend. The
 * virtualizer keys on that id, so the active group's subtree is reused.
 *
 * Two layers of coverage:
 *   1. assignGroupIds unit tests -- the reconciliation invariant in isolation.
 *   2. useIncrementalGroups renderHook tests -- proves the hook actually WIRES
 *      assignGroupIds in (the failure mode the old isolated memo test missed).
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@/lib/types'
import { assignGroupIds, type DisplayGroup, useIncrementalGroups } from './grouping'

// Build a DisplayGroup whose entries carry the given seqs. id optional.
function mkGroup(type: DisplayGroup['type'], seqs: number[], id?: string): DisplayGroup {
  return {
    type,
    timestamp: 't',
    entries: seqs.map(seq => ({ seq }) as unknown as TranscriptEntry),
    ...(id ? { id } : {}),
  }
}

describe('assignGroupIds reconciliation', () => {
  it('assigns deterministic ids when there is no prior (first pass)', () => {
    const groups = [mkGroup('assistant', [1, 2]), mkGroup('user', [3])]
    assignGroupIds(groups, null)
    expect(groups[0].id).toBe('assistant-s1')
    expect(groups[1].id).toBe('user-s3')
  })

  it('keeps a group id stable across a TAIL-APPEND (the streaming bug)', () => {
    const prev = [mkGroup('assistant', [1, 2])]
    assignGroupIds(prev, null)
    const prevId = prev[0].id
    // Active group grew at its tail (seq 3 appended). Fresh object, no id yet.
    const next = [mkGroup('assistant', [1, 2, 3])]
    assignGroupIds(next, prev)
    expect(next[0].id).toBe(prevId) // <- stable -> virtualizer key holds -> no remount
  })

  it('keeps a group id stable across a HEAD-PRUNE (capped conversation)', () => {
    // Prior: a boundary group + a tail group.
    const prev = [mkGroup('assistant', [1, 2]), mkGroup('user', [3]), mkGroup('assistant', [4, 5])]
    assignGroupIds(prev, null)
    const boundaryId = prev[0].id
    const tailId = prev[2].id
    // Head prune drops seq 1 (boundary group loses its head) AND a new entry 6
    // lands on the tail group. Both groups are freshly rebuilt (no id).
    const next = [mkGroup('assistant', [2]), mkGroup('user', [3]), mkGroup('assistant', [4, 5, 6])]
    assignGroupIds(next, prev)
    expect(next[0].id).toBe(boundaryId) // carried via shared entry s2 (last-resort lookup)
    expect(next[2].id).toBe(tailId) // carried via shared first entry s4
  })

  it('gives a genuinely new group a fresh, non-colliding id', () => {
    const prev = [mkGroup('assistant', [1, 2])]
    assignGroupIds(prev, null)
    const next = [mkGroup('assistant', [1, 2], prev[0].id), mkGroup('user', [3])]
    assignGroupIds(next, prev)
    expect(next[0].id).toBe(prev[0].id) // ref-preserved (already had id) -> kept
    expect(next[1].id).toBe('user-s3') // new
    expect(next[1].id).not.toBe(next[0].id)
  })

  it('does not collide when a prior group SPLITS into two', () => {
    const prev = [mkGroup('assistant', [1, 2, 3])]
    assignGroupIds(prev, null)
    const splitId = prev[0].id
    const next = [mkGroup('assistant', [1]), mkGroup('assistant', [2, 3])]
    assignGroupIds(next, prev)
    expect(next[0].id).toBe(splitId) // first claimant wins
    expect(next[1].id).not.toBe(splitId) // second derives its own
    expect(next[1].id).toBe('assistant-s2')
  })

  it('does not mutate a ref-preserved group that already carries an id', () => {
    const preserved = mkGroup('assistant', [1, 2], 'assistant-s1')
    assignGroupIds([preserved], null)
    expect(preserved.id).toBe('assistant-s1')
  })
})

// Minimal assistant/user entries that processEntry groups predictably.
function asst(seq: number, text: string): TranscriptEntry {
  return {
    type: 'assistant',
    timestamp: 't',
    seq,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as TranscriptEntry
}
function usr(seq: number, text: string): TranscriptEntry {
  return {
    type: 'user',
    timestamp: 't',
    seq,
    message: { role: 'user', content: text },
  } as unknown as TranscriptEntry
}

describe('useIncrementalGroups wires stable group ids', () => {
  // cacheKey omitted -> per-instance cache, isolated per renderHook (no
  // module-cache pollution across tests).
  it('keeps every group id stable when a new entry appends to the active group', () => {
    const base = [asst(1, 'first turn'), usr(2, 'reply'), asst(3, 'second turn')]
    const { result, rerender } = renderHook(({ entries }) => useIncrementalGroups(entries), {
      initialProps: { entries: base },
    })
    const before = result.current.groups.map(g => g.id)
    expect(before).toHaveLength(3)
    expect(before.every(Boolean)).toBe(true)

    // seq 4 (another assistant entry) merges into the active group at its tail.
    rerender({ entries: [...base, asst(4, 'still working')] })
    const after = result.current.groups.map(g => g.id)
    expect(after).toEqual(before) // ALL ids stable -- including the active group's
  })

  it('assigns a fresh id to a genuinely new trailing group without disturbing prior ids', () => {
    const base = [asst(1, 'turn'), usr(2, 'reply')]
    const { result, rerender } = renderHook(({ entries }) => useIncrementalGroups(entries), {
      initialProps: { entries: base },
    })
    const before = result.current.groups.map(g => g.id)
    rerender({ entries: [...base, asst(3, 'new turn')] })
    const after = result.current.groups.map(g => g.id)
    expect(after.slice(0, before.length)).toEqual(before) // prior ids untouched
    expect(after).toHaveLength(before.length + 1)
    expect(new Set(after).size).toBe(after.length) // all unique
  })
})

describe('useIncrementalGroups backfill breaks (prepend anchor granularity)', () => {
  // Native anchorTo:'end' anchoring is ITEM-granular: a prepend that merges
  // into the reader's boundary group slides content under them uncompensated.
  // breakSeqs forces the boundary entry to start a NEW group so prepended
  // entries form separate items above. (2026-06-10 scroll-back-to-top bug.)
  // Seqs kept inside ONE seq bucket (91-95, GROUP_SEQ_SPAN=10) so these tests
  // exercise the breakSeqs mechanism itself, not the bucket bound.
  it('splits at the boundary seq and keeps the boundary group id stable across a prepend', () => {
    const breaks = new Set<number>()
    const tail = [asst(93, 'boundary turn'), usr(94, 'reply'), asst(95, 'latest')]
    const { result, rerender } = renderHook(
      ({ entries, signal }) => useIncrementalGroups(entries, undefined, signal, breaks),
      { initialProps: { entries: tail, signal: 93 } },
    )
    const boundaryId = result.current.groups[0].id
    expect(result.current.groups).toHaveLength(3)

    // Backfill: register the break at the old top entry, prepend older
    // assistant entries that would otherwise MERGE into the boundary group,
    // and flip the reset signal (as the windowing does via regroupSignal).
    breaks.add(93)
    const prepended = [asst(91, 'older turn'), asst(92, 'older still'), ...tail]
    rerender({ entries: prepended, signal: 91 })

    const after = result.current.groups
    // The prepended assistant entries form their OWN group; the boundary
    // entry starts a fresh group below them (no merge across the break).
    expect(after[0].entries.map(e => (e as { seq?: number }).seq)).toEqual([91, 92])
    expect(after[1].entries[0]).toMatchObject({ seq: 93 })
    // Boundary group id carried (firstK match) -> virtualizer key stable ->
    // native anchor finds it and compensates by its start shift.
    expect(after[1].id).toBe(boundaryId)
  })

  it('without a break, an intra-bucket prepend merges into the boundary group (the bug shape)', () => {
    const tail = [asst(93, 'boundary turn'), usr(94, 'reply')]
    const { result, rerender } = renderHook(
      ({ entries, signal }) => useIncrementalGroups(entries, undefined, signal, undefined),
      { initialProps: { entries: tail, signal: 93 } },
    )
    expect(result.current.groups).toHaveLength(2)
    rerender({ entries: [asst(91, 'older'), asst(92, 'older2'), ...tail], signal: 91 })
    // Documents the merge behavior the break exists to prevent (within one
    // bucket; across buckets the GROUP_SEQ_SPAN bound already splits).
    expect(result.current.groups[0].entries.map(e => (e as { seq?: number }).seq)).toEqual([91, 92, 93])
  })
})

describe('seq-bucket group size bound (GROUP_SEQ_SPAN)', () => {
  // The scrollback-jank fix: no user/assistant group may span an absolute seq
  // bucket, so no virtual item grows to thousands of px and anchorTo:'end'
  // anchoring/compensation stays fine-grained. Splits are absolute-keyed, so
  // any regroup reproduces identical boundaries -> stable ids.
  it('splits a long assistant run at the bucket boundary and marks the continuation', () => {
    const entries = [asst(8, 'a'), asst(9, 'b'), asst(10, 'c'), asst(11, 'd')]
    const { result } = renderHook(() => useIncrementalGroups(entries))
    const groups = result.current.groups
    expect(groups).toHaveLength(2)
    expect(groups[0].entries.map(e => (e as { seq?: number }).seq)).toEqual([8, 9])
    expect(groups[1].entries.map(e => (e as { seq?: number }).seq)).toEqual([10, 11])
    expect(groups[0].continuation).toBeUndefined()
    expect(groups[1].continuation).toBe(true) // rendered headerless
  })

  it('produces identical split points regardless of window start (absolute buckets)', () => {
    const full = [asst(8, 'a'), asst(9, 'b'), asst(10, 'c'), asst(11, 'd')]
    const fromMidBucket = full.slice(1) // window opens at seq 9
    const a = renderHook(() => useIncrementalGroups(full)).result.current.groups
    const b = renderHook(() => useIncrementalGroups(fromMidBucket)).result.current.groups
    // Both regroups split before seq 10; the seq-10 group's id matches.
    expect(a[1].entries[0]).toMatchObject({ seq: 10 })
    expect(b[1].entries[0]).toMatchObject({ seq: 10 })
    expect(a[1].id).toBe(b[1].id)
  })

  it('keeps prior group ids stable when streaming crosses a bucket boundary', () => {
    const base = [asst(8, 'a'), asst(9, 'b')]
    const { result, rerender } = renderHook(({ entries }) => useIncrementalGroups(entries), {
      initialProps: { entries: base },
    })
    const before = result.current.groups.map(g => g.id)
    rerender({ entries: [...base, asst(10, 'c')] })
    const after = result.current.groups
    expect(after.map(g => g.id).slice(0, before.length)).toEqual(before)
    expect(after).toHaveLength(before.length + 1) // new small item appended
    expect(after[after.length - 1].continuation).toBe(true)
  })

  it('never splits on seqless entries (pre-seq shapes keep merging)', () => {
    const seqless = (text: string) =>
      ({
        type: 'assistant',
        timestamp: 't',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      }) as unknown as TranscriptEntry
    const { result } = renderHook(() => useIncrementalGroups([seqless('a'), seqless('b'), seqless('c')]))
    expect(result.current.groups).toHaveLength(1)
  })
})
