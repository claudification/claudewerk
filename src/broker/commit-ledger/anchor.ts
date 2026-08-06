/**
 * Commit -> transcript anchor.
 *
 * `TranscriptStore.find` orders by `id ASC` and applies LIMIT at the SQL layer,
 * so `{before, limit: 1}` returns the OLDEST entry in the conversation, not the
 * nearest one before the commit. The nearest-before we actually want comes from
 * a BOUNDED window ending at the commit, taking the last row -- which also keeps
 * the query index-backed instead of pulling a whole conversation into memory.
 */

import type { StoreDriver } from '../store/types'

/** Widening ladder. Most commits land seconds after the tool call that made
 *  them; the long tail is a conversation that sat idle before committing. */
const WINDOWS_MS = [15 * 60_000, 6 * 60 * 60_000, 7 * 24 * 60 * 60_000]
const PAGE = 200
/** Forward-paging cap. A busy conversation can hold more than one page inside
 *  the window, and `find` returns the FIRST page (id ASC), so we walk forward
 *  to reach the true nearest-before. 10 pages is a generous ceiling; past it
 *  the anchor is close enough that another round trip buys nothing. */
const MAX_PAGES = 10

export interface TranscriptAnchor {
  seq: number
  uuid: string
  timestamp: number
}

export function findTranscriptAnchor(
  store: StoreDriver,
  conversationId: string,
  committedAt: number,
): TranscriptAnchor | null {
  for (const window of WINDOWS_MS) {
    let cursor = committedAt - window
    let best: TranscriptAnchor | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const entries = store.transcripts.find(conversationId, { after: cursor, before: committedAt, limit: PAGE })
      const last = entries[entries.length - 1]
      if (!last) break
      best = { seq: last.seq, uuid: last.uuid, timestamp: last.timestamp }
      if (entries.length < PAGE || last.timestamp <= cursor) break
      cursor = last.timestamp
    }
    if (best) return best
  }
  return null
}
