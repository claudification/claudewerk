import { randomUUID } from 'node:crypto'
import type { TranscriptEntry } from '../../shared/protocol'
import type { StoreDriver, TranscriptAppendResult, TranscriptEntryInput } from '../store/types'

/** Resolve a transcript entry's timestamp (ISO string or absent) to epoch ms. */
export function resolveEntryTimestamp(raw: unknown): number {
  const ts = typeof raw === 'string' ? Date.parse(raw) : Date.now()
  return Number.isFinite(ts) ? ts : Date.now()
}

/** Map a live transcript entry to the store's input shape, tagging it with the
 *  scope `agentId` and synthesizing a uuid when the live wire omitted one.
 *
 *  The synthesized uuid is written BACK onto the entry: uuid is the store's
 *  dedup key, so an entry that keeps it only in the stored row is one the
 *  dashboard can never dedup either. */
function toTranscriptInput(e: TranscriptEntry, agentId: string | undefined): TranscriptEntryInput {
  const subtype = (e as Record<string, unknown>).subtype
  if (!e.uuid) e.uuid = randomUUID()
  return {
    type: e.type,
    subtype: typeof subtype === 'string' ? subtype : undefined,
    agentId,
    uuid: e.uuid,
    content: e as unknown as Record<string, unknown>,
    timestamp: resolveEntryTimestamp(e.timestamp),
  }
}

/**
 * Persist a batch of transcript entries to the StoreDriver so they're queryable
 * via the FTS5 search index. Shared by the parent ingest (add-transcript-entries)
 * and the agent sub-stream ingest (addSubagentTranscriptEntries) so both write
 * paths stay identical -- only the scope differs.
 *
 * `agentId` selects the scope: absent = the parent stream (`agent_id IS NULL`);
 * a value = that agent's sub-stream. The append assigns a seq monotonic per
 * (conversationId, agentId), so agent rows never punch holes in the parent seq.
 *
 * INSERT OR IGNORE on (conversation_id, uuid) makes re-reads on hydrate/reconnect
 * idempotent; entries without a uuid get one synthesized (the live wire format
 * makes uuid optional, but the store treats it as the dedup key).
 *
 * `isRegistered` is the orphan guard -- never persist rows for a conversation
 * absent from the in-memory Map. getAllConversations serves only the Map, so a
 * store row with no Map entry is unreachable; skipping keeps store and Map
 * consistent. Failures are swallowed: search degrades, transcript ingest keeps
 * working for the dashboard.
 *
 * Returns the store's per-entry seq decisions (input order, one per entry), or
 * `null` when nothing was persisted -- no store, orphan-guarded, or the append
 * threw. `null` means "the store has no opinion on these seqs", and the caller
 * must fall back to the in-memory counter.
 */
export function persistTranscriptEntries(
  store: Pick<StoreDriver, 'transcripts'> | undefined,
  isRegistered: boolean,
  conversationId: string,
  entries: TranscriptEntry[],
  agentId?: string,
): TranscriptAppendResult[] | null {
  if (!store || entries.length === 0) return null
  if (!isRegistered) {
    console.warn(
      `[transcript-store] skipped ${entries.length} entries for unregistered conversation ${conversationId.slice(0, 8)} (orphan-prevented)`,
    )
    return null
  }
  return appendToStore(store, conversationId, entries, agentId)
}

/** Map + append the batch, swallowing store errors so transcript ingest never
 *  breaks when the DB is unhappy (search just misses these rows until recovery). */
function appendToStore(
  store: Pick<StoreDriver, 'transcripts'>,
  conversationId: string,
  entries: TranscriptEntry[],
  agentId: string | undefined,
): TranscriptAppendResult[] | null {
  try {
    return store.transcripts.append(
      conversationId,
      'live',
      entries.map(e => toTranscriptInput(e, agentId)),
    )
  } catch (err) {
    console.error('[transcript-store] append failed:', err instanceof Error ? err.message : err)
    return null
  }
}
