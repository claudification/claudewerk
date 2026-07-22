/**
 * ONE conversion from a stored transcript ROW to the wire-shaped TranscriptEntry
 * the extractors read.
 *
 * The store keeps an entry's payload in `content`, so every reader has to splat
 * it back out alongside the columns. Three private copies of that splat is how
 * one of them quietly forgets `subtype` and starts mis-reading turns.
 */

import type { TranscriptEntry } from '../../../shared/protocol'

/** The columns this conversion reads -- STRUCTURAL, so a caller can hand over a
 *  real `TranscriptEntryRecord` or a hand-built row without dragging the store
 *  types into modules that must not know about them. */
export interface StoredTranscriptRow {
  type: string
  subtype?: string
  uuid: string
  timestamp: number
  content: Record<string, unknown>
}

export function toTranscriptEntry(rec: StoredTranscriptRow): TranscriptEntry {
  return {
    type: rec.type,
    uuid: rec.uuid,
    timestamp: rec.timestamp,
    ...(rec.subtype ? { subtype: rec.subtype } : {}),
    ...rec.content,
    // `timestamp` is an epoch here and a string on the wire shape; every reader
    // parses both (transcript-extract.parseTimestamp), so the cast is the honest
    // description of what is going on rather than a lie about the field.
  } as unknown as TranscriptEntry
}
