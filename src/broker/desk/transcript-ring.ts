/**
 * The VIEWABLE TRANSCRIPT ring (plan-dispatcher-persistence.md A0).
 *
 * The last N user/assistant turns kept for the user to SCROLL AND READ -- a
 * separate FIFO copy that is DECOUPLED from the LLM context window. Consolidation
 * prunes aged turns out of the LivingHistory (to keep the submitted context tiny);
 * it must NEVER remove a turn from this ring. Only the FIFO cap evicts here.
 *
 * Keyed by an already-resolved userKey so this module has no dependency on the
 * history-store (which owns userKey + the LivingHistory) -- it wraps these.
 */

import type { Role, Turn } from './living-history'

/** The viewable-transcript ring cap (the last N user/assistant turns). */
const TRANSCRIPT_CAP = 100

const transcripts = new Map<string, Turn[]>()

/** Append a turn to a user's ring; FIFO-evict from the front past the cap. */
export function recordTurnByKey(key: string, role: Role, content: string, ts: number): void {
  let ring = transcripts.get(key)
  if (!ring) {
    ring = []
    transcripts.set(key, ring)
  }
  ring.push({ kind: 'turn', role, content, ts })
  if (ring.length > TRANSCRIPT_CAP) ring.splice(0, ring.length - TRANSCRIPT_CAP)
}

/** The user's viewable transcript ring (the last <=100 turns). Live reference --
 *  callers must not mutate it; copy before handing out. */
export function getTranscriptByKey(key: string): Turn[] {
  return transcripts.get(key) ?? []
}

/** Replace a user's whole ring (persistence load on boot). */
export function setTranscriptByKey(key: string, turns: Turn[]): void {
  transcripts.set(key, turns.slice(-TRANSCRIPT_CAP))
}

/** Drop a user's ring (explicit reset). */
export function clearTranscriptByKey(key: string): void {
  transcripts.delete(key)
}
