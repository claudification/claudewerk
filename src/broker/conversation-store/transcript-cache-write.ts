/**
 * Writes into the in-memory parent transcript cache.
 *
 * The cache is what `handlers/transcript.ts` serves a dashboard in preference
 * to the store, so anything lost here is lost on screen. Two invariants:
 *
 *  1. It is always CHRONOLOGICALLY ordered (see transcript-order.ts).
 *  2. `isInitial` RECONCILES it; it never swaps it for the incoming batch.
 *
 * Invariant 2 is the one that was broken. `isInitial` used to mean "this batch
 * is the whole record, replace everything" -- true for PTY, false for HEADLESS,
 * where the resend is read from CC's JSONL and then narrowed further by
 * `selectForwardableEntries`. Such a batch carries no `system/status`, no
 * `notification`, no `away_summary`, no `background_tasks_changed`, no
 * `queue-operation`: those exist only on the stdout pipe, never in the file.
 * Overwriting the cache with it deleted every one of them, and the next
 * conversation open served that gutted set.
 *
 * The store is append-only (`INSERT OR IGNORE`) and therefore holds the UNION
 * of the stdout and file paths. Rebuilding from the store is both the complete
 * answer and the cheap one -- one indexed read per resend.
 */

import type { TranscriptEntry } from '../../shared/protocol'
import { insertTranscriptEntriesInOrder, sortTranscriptEntries } from '../../shared/transcript-order'
import { MAX_TRANSCRIPT_ENTRIES } from './constants'
import type { ConversationStoreContext } from './event-context'

/**
 * Apply a batch to the cache.
 *
 * `isInitial` rebuilds from the store (falling back to a uuid-merge when there
 * is no store); otherwise the batch is spliced into chronological position --
 * a push for the live case, a binary search for a late gap-fill.
 */
export function writeTranscriptCache(
  ctx: ConversationStoreContext,
  conversationId: string,
  entries: TranscriptEntry[],
  isInitial: boolean,
): void {
  if (isInitial) {
    ctx.transcriptCache.set(conversationId, reconcileInitial(ctx, conversationId, entries))
    return
  }
  const existing = ctx.transcriptCache.get(conversationId) || []
  insertTranscriptEntriesInOrder(existing, entries)
  trimHead(existing)
  ctx.transcriptCache.set(conversationId, existing)
}

/** The full record for this conversation after an `isInitial` batch. */
function reconcileInitial(
  ctx: ConversationStoreContext,
  conversationId: string,
  entries: TranscriptEntry[],
): TranscriptEntry[] {
  const fromStore = readParentScope(ctx, conversationId)
  // The store already absorbed `entries` (persist runs before the cache write),
  // so its answer is the union and needs no further merging.
  if (fromStore) return fromStore
  // No store: merge by uuid so a partial batch still cannot drop what we hold.
  return mergeByUuid(ctx.transcriptCache.get(conversationId) || [], entries)
}

/** Parent-scope (`agent_id IS NULL`) entries, newest-capped and ordered.
 *  `null` when there is no store or it holds nothing for this conversation. */
function readParentScope(ctx: ConversationStoreContext, conversationId: string): TranscriptEntry[] | null {
  if (!ctx.store) return null
  const records = ctx.store.transcripts.getLatest(conversationId, MAX_TRANSCRIPT_ENTRIES, null)
  if (records.length === 0) return null
  return sortTranscriptEntries(records.map(r => ({ ...r.content, seq: r.seq }) as TranscriptEntry))
}

/**
 * Union of what we hold and what just arrived, keyed on uuid.
 *
 * Builds on the ALREADY-ordered cache and splices in only the entries it does
 * not have, rather than re-sorting the union: without a store the seqs are not
 * globally comparable (an `isInitial` batch resets the counter), so a global
 * sort would interleave on a meaningless tie-break. Ordered insert places a
 * dated entry by its clock and leaves an undated one where it arrived.
 */
function mergeByUuid(existing: TranscriptEntry[], incoming: TranscriptEntry[]): TranscriptEntry[] {
  const held = new Set(existing.map(e => e.uuid).filter(Boolean))
  // A uuid-less entry cannot be deduped -- keep it, duplicates are the lesser
  // evil against dropping an entry nothing else can recover.
  const missing = incoming.filter(e => !e.uuid || !held.has(e.uuid))
  const merged = [...existing]
  insertTranscriptEntriesInOrder(merged, missing)
  trimHead(merged)
  return merged
}

/** Drop the oldest entries once the cache exceeds its cap. */
function trimHead(entries: TranscriptEntry[]): void {
  if (entries.length > MAX_TRANSCRIPT_ENTRIES) {
    entries.splice(0, entries.length - MAX_TRANSCRIPT_ENTRIES)
  }
}
