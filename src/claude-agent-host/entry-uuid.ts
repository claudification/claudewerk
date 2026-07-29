/**
 * Deterministic uuids for transcript entries CC leaves unidentified.
 *
 * The uuid is the broker's dedup key (`INSERT OR IGNORE` on
 * `(conversation_id, uuid)`), so it decides what a replay does. CC assigns uuids
 * to tool results but not to user-typed messages or to its own JSONL control
 * lines, and a RANDOM id for those would make every reconnect insert the same
 * logical entry again -- a new row, a fresh high seq, the original timestamp, so
 * it sorts to the bottom and shoves the display window around. Hashing the
 * CONTENT instead makes the same logical entry hash to the same id, and the
 * replay collapses into the row it already wrote.
 *
 * Which is only true if the hash can SEE the content. The hash reads
 * `message ?? type`, and CC's metadata control lines have no `message` and no
 * `timestamp` -- `{"type":"custom-title","customTitle":"x","sessionId":"y"}` is
 * the entire line. Every custom-title in existence therefore hashed to one id,
 * so the store kept the FIRST title a conversation ever had and silently dropped
 * every later one as a duplicate. Same for agent-name and summary. The
 * disambiguator table below is what lets two different titles be two different
 * entries, which is the precondition for folding conversation state over
 * store-fresh entries only.
 */

import { createHash } from 'node:crypto'
import type { TranscriptEntry } from '../shared/protocol'

/**
 * What makes two same-typed entries at the same timestamp distinct, per type.
 *
 * `queue-operation` was the original member and its expression is preserved
 * BYTE-FOR-BYTE: changing it would re-hash every queue-operation entry and
 * re-insert the lot on the next replay. CC writes an `enqueue` and its matching
 * `dequeue` on the SAME millisecond whenever a message is taken straight away,
 * and without this both collapse onto one uuid -- the dequeue is dropped and the
 * "queued" badge survives every reload with nothing left to clear it.
 */
const DISAMBIGUATORS: Record<string, (raw: Record<string, unknown>) => string> = {
  'queue-operation': raw => `:${raw.operation}:${String(raw.content ?? '').slice(0, 120)}`,
  'custom-title': raw => `:${String(raw.customTitle ?? '')}`,
  'agent-name': raw => `:${String(raw.agentName ?? '')}`,
  summary: raw => `:${String(raw.summary ?? '').slice(0, 200)}:${String(raw.leafUuid ?? '')}`,
  'pr-link': raw => `:${String(raw.prNumber ?? '')}:${String(raw.prUrl ?? '')}`,
}

export function uuidDisambiguator(entry: TranscriptEntry): string {
  return DISAMBIGUATORS[entry.type]?.(entry as Record<string, unknown>) ?? ''
}

/** Format a sha1 as a v5-shaped uuid string. Cosmetic -- readers expect the
 *  dashes and the version nibble, nothing derives meaning from them. */
function formatUuid(hash: string): string {
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/**
 * Stamp deterministic uuids on entries that lack them, in place.
 *
 * Applies to BOTH headless (stream-json) and PTY (JSONL watcher) paths since
 * both funnel through `sendTranscriptEntriesChunked`. Entries that already carry
 * CC's own uuid are left alone.
 */
export function stampDeterministicUuids(entries: TranscriptEntry[]): void {
  for (const e of entries) {
    if (e.uuid) continue
    const content = JSON.stringify((e as Record<string, unknown>).message ?? e.type).slice(0, 200)
    const hash = createHash('sha1')
      .update(`${e.type}:${e.timestamp}:${content}${uuidDisambiguator(e)}`)
      .digest('hex')
    e.uuid = formatUuid(hash)
  }
}
