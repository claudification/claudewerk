/**
 * Pure core of the progressive transcript window: constants + anchor math.
 * Unit-tested via transcript-anchor-loop.test.tsx; the stateful hook lives in
 * use-transcript-window.ts.
 */

import type { TranscriptEntry } from '@/lib/types'
import { isDisplayableEntry } from './grouping/parsers'

// Open/switch renders a window of the last WINDOW_SIZE *displayable* entries;
// scrollback reveals LOAD_CHUNK more. Conversations at or below WINDOW_THRESHOLD
// raw entries render whole. Budgeting by DISPLAYABLE entries (not raw) is
// deliberate: a raw slice was dominated by status heartbeats and tool_result
// entries (every tool call = tool_use + tool_result = 2 raw for 1 visible item),
// so the last-50-raw window opened with only a handful of real items and the top
// sentinel fired load-older immediately.
export const WINDOW_SIZE = 50
export const WINDOW_THRESHOLD = 80
export const LOAD_CHUNK = 100
/** Hard cap on how many RAW entries the displayable walk scans back for the
 *  default window, so a pathologically noise-dense tail can't drag the whole
 *  conversation into the initial render. ~50 displayable normally costs
 *  100-150 raw; this leaves generous headroom while staying bounded. */
const WINDOW_MAX_RAW = 300
/** Re-anchor the seq-anchored window forward once the boundary entry drifts to
 *  within this many entries of the pruned head. Keeps a safety buffer above the
 *  live prune line so the anchor entry is never the one pruned (which would pin
 *  windowStart at 0 and reintroduce per-tick regroup thrash). */
export const WINDOW_REANCHOR_MARGIN = 8

/** Default window start index: walk back from the tail counting DISPLAYABLE
 *  entries until WINDOW_SIZE of them are covered (bounded by WINDOW_MAX_RAW raw
 *  entries), or 0 when the transcript is short enough that windowing buys
 *  nothing. Returns the raw index of the boundary entry. */
function defaultWindowStart(entries: TranscriptEntry[]): number {
  const len = entries.length
  if (len <= WINDOW_THRESHOLD) return 0
  const floor = Math.max(0, len - WINDOW_MAX_RAW)
  let displayable = 0
  let i = len - 1
  for (; i > floor; i--) {
    if (isDisplayableEntry(entries[i])) displayable++
    if (displayable >= WINDOW_SIZE) break
  }
  return i
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
  const idx = defaultWindowStart(entries)
  if (idx <= 0) return null
  for (let i = idx; i < entries.length; i++) {
    const s = entries[i]?.seq
    if (s !== undefined && s !== null) return s
  }
  return null
}
