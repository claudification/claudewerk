/**
 * Turning a full-file replay into a delta.
 *
 * A reconnect used to re-send the WHOLE transcript, every time, for every
 * conversation. Not because anything needed it -- the broker's rows are durable
 * and deduped on uuid -- but because `transcript_request` carried no cursor, so
 * the host's only two options were "send nothing" and "send the file". It sent
 * the file: up to 500 entries plus every hoisted metadata line, per conversation,
 * per broker restart.
 *
 * The broker now says what it already has and the host sends only what follows.
 *
 * WHY A SET RATHER THAN A "LAST SEEN" MARKER. Two reasons, both load-bearing:
 *
 *   - Headless has two disjoint sources. Entries arrive over stdout AND out of
 *     the JSONL, and neither is a superset of the other, so the newest entry the
 *     broker holds is frequently one with no counterpart in the file at all. A
 *     positional cursor would miss and fall back to a full replay on exactly the
 *     transport that reconnects most.
 *   - Compaction rewrites the file. A marker can vanish outright; a set just
 *     recognizes fewer entries and degrades into sending a bit more.
 *
 * So the host scans BACKWARDS for the newest file entry the broker already knows
 * and forwards everything after it. Recognizing nothing means a full replay,
 * which is exactly the old behaviour -- the failure mode is "we did what we used
 * to do", never "we lost an entry".
 */

import type { TranscriptEntry } from '../shared/protocol'

export interface ResendCut {
  entries: TranscriptEntry[]
  /** How many leading entries the broker already had. */
  skipped: number
  /** False when nothing was recognized and we fell back to a full replay. */
  matched: boolean
}

/**
 * Drop the leading run of entries the broker already holds.
 *
 * Cuts after the LAST recognized entry rather than filtering set members out
 * one by one: a gap in the middle means the broker is missing something, and
 * re-sending across it is the whole point of a resend. Only the uninterrupted
 * known prefix is safe to skip.
 */
export function cutKnownPrefix(entries: TranscriptEntry[], known: ReadonlySet<string> | null): ResendCut {
  if (!known?.size) return { entries, skipped: 0, matched: false }
  for (let i = entries.length - 1; i >= 0; i--) {
    const uuid = entries[i].uuid
    if (uuid && known.has(uuid)) {
      return { entries: entries.slice(i + 1), skipped: i + 1, matched: true }
    }
  }
  return { entries, skipped: 0, matched: false }
}
