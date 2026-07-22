/**
 * Transcript ingest + broadcast, in one call.
 *
 * Every path that appends to a conversation's transcript has to do the same two
 * things in the same order: hand the entries to the store, then tell subscribed
 * dashboards. A dozen call sites had that pair inlined, which meant a dozen
 * copies of the same subtle mistake -- broadcasting the array that was passed
 * IN rather than the entries the ingest actually ACCEPTED.
 *
 * That distinction is the whole point. `addTranscriptEntries` drops entries the
 * store already holds (a re-sent event, a replayed buffer, an overlapping tail
 * read), because the dashboards already have them. Broadcasting the input array
 * pushed those duplicates out anyway, and since the dashboard dedups by `seq`
 * -- which a re-ingest used to mint fresh -- they rendered a second time.
 *
 * Use this instead of calling `addTranscriptEntries` + `broadcastToChannel` by
 * hand. It returns the accepted entries for callers that need to know whether
 * anything actually landed.
 */

import type { TranscriptEntry } from '../shared/protocol'
import type { ConversationStore } from './conversation-store'

/** The slice of ConversationStore this needs -- keeps callers (and their tests)
 *  from having to supply a whole store just to append one entry. */
export type TranscriptIngestTarget = Pick<ConversationStore, 'addTranscriptEntries' | 'broadcastToChannel'>

/**
 * Append `entries` to the conversation's transcript and broadcast whatever was
 * accepted. Returns the accepted entries -- empty means every entry was already
 * stored and nothing was sent.
 *
 * Always a non-initial APPEND. A full-snapshot REPLACE (`isInitial`) has to
 * broadcast entries the store already has, so it stays with the one handler
 * that owns that case (handlers/transcript.ts).
 */
export function ingestAndBroadcast(
  store: TranscriptIngestTarget,
  conversationId: string,
  entries: TranscriptEntry[],
): TranscriptEntry[] {
  const accepted = store.addTranscriptEntries(conversationId, entries, false)
  if (accepted.length === 0) return accepted
  store.broadcastToChannel('conversation:transcript', conversationId, {
    type: 'transcript_entries',
    conversationId,
    entries: accepted,
    isInitial: false,
  })
  return accepted
}
