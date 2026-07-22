/**
 * Regression: a queue `remove` that arrives out of chronological order must
 * still clear the "queued" badge.
 *
 * The incident (claudewerk:epic-phoenix, 2026-07-22): a headless message with
 * an image floated as QUEUED forever even though the agent had already consumed
 * it. The `remove` signal WAS delivered and persisted (broker seq 133) -- the
 * client dropped it during grouping.
 *
 * Two production behaviours collide:
 *   1. applyTranscriptBatch orders the render array by (timestamp, seq), not
 *      arrival. The `remove` (ts .883) is stamped 1ms BEFORE the `system/status`
 *      entry that reached the array first (ts .884), so it SPLICES mid-array
 *      instead of appending.
 *   2. useIncrementalGroups regrouped only `entries.slice(len)` -- a count-based
 *      tail slice. A mid-array splice grows length without touching the tail, so
 *      the spliced `remove` was never processed and the badge never cleared.
 *
 * The fix: useIncrementalGroups detects that the tail entry shifted (a mid-array
 * insert) and forces a full regroup. This test drives the REAL hook with arrays
 * built by the REAL applyTranscriptBatch, in true arrival order.
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { applyTranscriptBatch } from '@/lib/transcript-apply'
import type { TranscriptEntry } from '@/lib/types'
import { useIncrementalGroups } from '../grouping'

const MSG = "![img.png](https://x/y.png)\n.. trend is.. we're spending $10 / day"

function userEntry(seq: number, ts: string, content: string, uuid: string): TranscriptEntry {
  return { type: 'user', seq, timestamp: ts, uuid, message: { role: 'user', content } } as unknown as TranscriptEntry
}
function queueOp(seq: number, ts: string, operation: 'enqueue' | 'remove', content: string, uuid: string): TranscriptEntry {
  return { type: 'queue-operation', seq, timestamp: ts, uuid, operation, content } as unknown as TranscriptEntry
}
function statusEntry(seq: number, ts: string, uuid: string): TranscriptEntry {
  return { type: 'system', subtype: 'status', seq, timestamp: ts, uuid } as unknown as TranscriptEntry
}

// True arrival (seq) order. Note the timestamp inversion between seq 3 and 4:
// the remove's own clock is 1ms EARLIER than the status that arrived before it.
const ARRIVALS: TranscriptEntry[] = [
  userEntry(1, '2026-07-22T16:06:07.368Z', MSG, 'u-1'),
  queueOp(2, '2026-07-22T16:06:07.370Z', 'enqueue', MSG, 'q-enq'),
  statusEntry(3, '2026-07-22T16:06:20.884Z', 'sys-3'),
  queueOp(4, '2026-07-22T16:06:20.883Z', 'remove', MSG, 'q-rem'),
]

describe('queued badge clears when the remove arrives out of chronology', () => {
  it('drives the real hook through applyTranscriptBatch in arrival order', () => {
    let rendered: TranscriptEntry[] = []
    let localMax = 0
    const feed = (e: TranscriptEntry): TranscriptEntry[] => {
      const { result } = applyTranscriptBatch({ existing: rendered, incoming: [e], initial: false, localMax })
      rendered = result
      localMax = Math.max(localMax, (e as { seq?: number }).seq ?? 0)
      return rendered
    }

    // cacheKey omitted -> per-instance cache, isolated to this renderHook.
    const { result, rerender } = renderHook(({ entries }) => useIncrementalGroups(entries), {
      initialProps: { entries: feed(ARRIVALS[0]) },
    })
    for (let i = 1; i < ARRIVALS.length; i++) rerender({ entries: feed(ARRIVALS[i]) })

    // Sanity: the remove really did splice mid-array (not tail) -- proves the
    // scenario under test, not a degenerate append.
    expect(rendered[rendered.length - 1].type).toBe('system')
    expect(rendered.some(e => e.type === 'queue-operation' && (e as { operation?: string }).operation === 'remove')).toBe(true)

    const groups = result.current.groups
    const stuck = groups.filter(g => g.queued)
    expect(stuck).toEqual([])
    // The bubble still renders exactly once (not lost, not duplicated).
    const userGroups = groups.filter(g => g.type === 'user' && !g.queued)
    expect(userGroups).toHaveLength(1)
  })
})
