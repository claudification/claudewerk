/**
 * Pure core of the progressive transcript window: constants + anchor math.
 * Unit-tested via transcript-anchor-loop.test.tsx; the stateful hook lives in
 * use-transcript-window.ts.
 */

import type { TranscriptEntry } from '@/lib/types'

// Render only the last WINDOW_SIZE entries on open/switch; scrollback reveals
// LOAD_CHUNK more. Conversations at or below WINDOW_THRESHOLD entries render
// whole (no window) -- the lever only matters for long transcripts that
// grouping collapses into a few giant groups.
export const WINDOW_SIZE = 50
export const WINDOW_THRESHOLD = 80
export const LOAD_CHUNK = 100
/** Re-anchor the seq-anchored window forward once the boundary entry drifts to
 *  within this many entries of the pruned head. Keeps a safety buffer above the
 *  live prune line so the anchor entry is never the one pruned (which would pin
 *  windowStart at 0 and reintroduce per-tick regroup thrash). */
export const WINDOW_REANCHOR_MARGIN = 8

/** Default window start: show the last WINDOW_SIZE entries, or all of them when
 *  the transcript is short enough that windowing buys nothing. */
function defaultWindowStart(len: number): number {
  return len > WINDOW_THRESHOLD ? len - WINDOW_SIZE : 0
}

/** The window boundary as a SEQ rather than an absolute index. Returns the seq
 *  of the entry at the default window start, or null when the transcript is
 *  short enough that no window applies (show all). Resilient to a SEQLESS
 *  boundary entry (raw-JSONL entries before the broker stamps seq): scans
 *  FORWARD for the nearest entry that carries one so the window still anchors
 *  instead of collapsing to show-all. Returns null only when NO entry from the
 *  boundary onward has a seq -- which also keeps the render-phase re-anchor
 *  convergent (React #301). */
export function defaultAnchorSeq(entries: TranscriptEntry[]): number | null {
  const idx = defaultWindowStart(entries.length)
  if (idx <= 0) return null
  for (let i = idx; i < entries.length; i++) {
    const s = entries[i]?.seq
    if (s !== undefined && s !== null) return s
  }
  return null
}
