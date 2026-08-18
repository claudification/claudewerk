/**
 * Shared helpers for the query-less transcript read paths (`browse`, and
 * `getWindow`'s tail mode).
 *
 * Both drivers implement these against completely different storage -- SQL vs
 * in-memory arrays -- but the CONTRACT has to be identical: same clamps, same
 * snippet shape. Anything a caller could observe lives here so the two cannot
 * silently drift apart.
 */

import type { BrowseOpts, WindowOpts } from './types'

const DEFAULT_PREVIEW_LEN = 200
const MAX_LIMIT = 100
const MAX_WINDOW = 50

/**
 * Snippet text for a browse hit.
 *
 * `search()` gets its snippet from FTS5 -- a window centred on the match, with
 * `<mark>` around the term. A browse hit has no match to centre on, so it takes
 * the head of the content instead.
 */
export function buildBrowsePreview(content: unknown, maxLen = DEFAULT_PREVIEW_LEN): string {
  const raw = typeof content === 'string' ? content : JSON.stringify(content ?? '')
  if (!raw) return ''
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > maxLen ? `${flat.slice(0, maxLen)}...` : flat
}

/** Page bounds for a browse call: 1..100 results, non-negative offset. */
export function clampBrowsePaging(opts: BrowseOpts | undefined): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(opts?.limit ?? 20, 1), MAX_LIMIT),
    offset: Math.max(opts?.offset ?? 0, 0),
  }
}

/** Window bounds for getWindow: 0..50 either side of a centre, 1..100 for a tail. */
export function clampWindowBounds(opts: WindowOpts): { before: number; after: number; tail: number | null } {
  return {
    before: Math.min(Math.max(opts.before ?? 5, 0), MAX_WINDOW),
    after: Math.min(Math.max(opts.after ?? 5, 0), MAX_WINDOW),
    tail: opts.tail == null ? null : Math.min(Math.max(opts.tail, 1), MAX_LIMIT),
  }
}
