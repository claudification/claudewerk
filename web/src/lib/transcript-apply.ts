/**
 * How a transcript batch off the wire becomes the array we render.
 *
 * Two rules, both learned the hard way:
 *
 * 1. AN `isInitial` BATCH IS NOT A SNAPSHOT. It is whatever the agent host could
 *    read back, and in headless that is CC's JSONL narrowed by the host's
 *    forward policy -- so it carries none of the stdout-only entries
 *    (`system/status`, `notification`, `away_summary`,
 *    `background_tasks_changed`, `queue-operation`). Swapping our array for it
 *    deleted every one of them on screen. It is a RECONCILIATION: union by
 *    uuid, never a replace.
 *
 *    The guard this replaces compared only `entries[0]`'s content fingerprint
 *    and fell open the moment the first entry differed (compaction rewrites the
 *    prefix, `/clear` starts a new one), which is exactly when the batch is
 *    least trustworthy.
 *
 * 2. ARRIVAL ORDER IS NOT CHRONOLOGY. An entry recovered from the file lands
 *    with an old timestamp and a brand new high seq, so a blind
 *    `[...existing, ...fresh]` pinned it below entries that happened long after
 *    it. Ordering is `(timestamp, seq)` -- see shared/transcript-order.ts.
 */

import type { TranscriptEntry } from '@shared/protocol'
import { insertTranscriptEntriesInOrder, sortTranscriptEntries } from '@shared/transcript-order'

export interface ApplyTranscriptBatch {
  existing: TranscriptEntry[]
  incoming: TranscriptEntry[]
  initial: boolean
  /** Highest seq already applied -- the incremental dedup floor. */
  localMax: number
}

export interface AppliedTranscriptBatch {
  /** The new array, or `existing` BY REFERENCE when nothing changed. */
  result: TranscriptEntry[]
  /** True when the batch added nothing (logging + render short-circuit). */
  unchanged: boolean
}

export function applyTranscriptBatch({
  existing,
  incoming,
  initial,
  localMax,
}: ApplyTranscriptBatch): AppliedTranscriptBatch {
  // An incremental batch is dedup'd on seq: it guards the race where a
  // sync_check delta fetch and a live broadcast deliver the same entries.
  const candidates = initial ? incoming : incoming.filter(e => e.seq === undefined || e.seq > localMax)
  const fresh = withoutHeldUuids(existing, candidates)
  if (fresh.length === 0) return { result: existing, unchanged: true }

  // An isInitial batch is an unordered SNAPSHOT, not a near-sorted append. A
  // headless resend is read from CC's JSONL in FILE order, which puts a skill's
  // injected body (stamped ~150ms before the tool_result that names it) AHEAD of
  // its invocation. The incremental splice below cannot repair that: its
  // jitter clamp only fires for an entry whose seq continues the tail, and the
  // invocation's seq is LOWER than the body it must precede -- so the body kept
  // its wrong lead and the grouper rendered it as a fat user bubble instead of a
  // `/skill` band. A full clamp-sort of the union restores `(timestamp, seq)`
  // arrival order for every inverted pair (skills, compact, stop-hook, api_error
  // late-arrivals alike). The live/incremental path stays a cheap tail-splice.
  if (initial) return { result: sortTranscriptEntries([...existing, ...fresh]), unchanged: false }

  const result = [...existing]
  insertTranscriptEntriesInOrder(result, fresh)
  return { result, unchanged: false }
}

/** Entries we do not already hold. A uuid-less entry cannot be matched, so it
 *  is kept: a duplicate renders twice, a drop loses the only copy. */
function withoutHeldUuids(existing: TranscriptEntry[], incoming: TranscriptEntry[]): TranscriptEntry[] {
  if (incoming.length === 0) return incoming
  const held = new Set<string>()
  for (const e of existing) if (e.uuid) held.add(e.uuid)
  return incoming.filter(e => !e.uuid || !held.has(e.uuid))
}
