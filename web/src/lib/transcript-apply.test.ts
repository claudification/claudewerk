/**
 * The two client-side rules in lib/transcript-apply.ts, each pinned to the
 * production failure it came from:
 *
 *  - a partial `isInitial` batch must not delete what we hold (rows vanishing
 *    on conversation open/switch),
 *  - a late gap-fill must render where it happened, not at the bottom (the
 *    20:23 entry sitting under the 20:42 one).
 */

import { describe, expect, it } from 'vitest'
import { applyTranscriptBatch } from '@/lib/transcript-apply'
import type { TranscriptEntry } from '@/lib/types'

const at = (uuid: string, seconds: number, seq: number, type = 'assistant'): TranscriptEntry =>
  ({
    type,
    uuid,
    seq,
    timestamp: new Date(Date.UTC(2026, 6, 22, 13, 0, seconds)).toISOString(),
  }) as unknown as TranscriptEntry

const ids = (entries: TranscriptEntry[]): string[] => entries.map(e => e.uuid as string)

describe('applyTranscriptBatch', () => {
  // The headless resend: read from CC's JSONL, so it carries user/assistant but
  // none of the stdout-only rows. Replacing on this is what emptied transcripts.
  it('keeps stdout-only entries when a partial isInitial batch arrives', () => {
    const existing = [
      at('u1', 1, 1, 'user'),
      at('status', 2, 2, 'system'),
      at('a1', 3, 3),
      at('queue', 4, 4, 'queue-operation'),
    ]
    const { result } = applyTranscriptBatch({
      existing,
      incoming: [at('u1', 1, 1, 'user'), at('a1', 3, 3)],
      initial: true,
      localMax: 4,
    })
    expect(ids(result)).toEqual(['u1', 'status', 'a1', 'queue'])
  })

  it('adds entries an isInitial batch brings that we did not have', () => {
    const { result } = applyTranscriptBatch({
      existing: [at('a', 10, 1)],
      incoming: [at('a', 10, 1), at('b', 20, 2)],
      initial: true,
      localMax: 1,
    })
    expect(ids(result)).toEqual(['a', 'b'])
  })

  // THE screenshot. Recovered from the file 26 minutes late, so its seq is the
  // highest in the conversation while its timestamp is among the oldest.
  // Lateness is in MINUTES because that is what a real resend looks like -- a
  // few seconds behind is CC's non-monotonic clock on entries that arrived IN
  // order, which shared/transcript-order.ts deliberately refuses to re-sort.
  it('places a late gap-fill by timestamp, not at the tail', () => {
    const min = 60
    const existing = [at('early', 10 * min, 1), at('mid', 30 * min, 2), at('late', 40 * min, 3)]
    const { result } = applyTranscriptBatch({
      existing,
      incoming: [at('recovered', 20 * min, 178)],
      initial: false,
      localMax: 3,
    })
    expect(ids(result)).toEqual(['early', 'recovered', 'mid', 'late'])
  })

  it('appends a normal live entry at the end', () => {
    const { result } = applyTranscriptBatch({
      existing: [at('a', 10, 1)],
      incoming: [at('b', 20, 2)],
      initial: false,
      localMax: 1,
    })
    expect(ids(result)).toEqual(['a', 'b'])
  })

  it('drops an incremental entry at or below the applied seq floor', () => {
    const existing = [at('a', 10, 1), at('b', 20, 2)]
    const applied = applyTranscriptBatch({ existing, incoming: [at('b', 20, 2)], initial: false, localMax: 2 })
    expect(applied.unchanged).toBe(true)
    // Same reference: nothing changed, so React must not see a new array.
    expect(applied.result).toBe(existing)
  })

  it('does not duplicate an entry the batch repeats', () => {
    const existing = [at('a', 10, 1)]
    const { result } = applyTranscriptBatch({
      existing,
      incoming: [at('a', 10, 1), at('b', 20, 2)],
      initial: true,
      localMax: 1,
    })
    expect(ids(result)).toEqual(['a', 'b'])
  })
})
