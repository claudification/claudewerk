/**
 * THE WALL's shared time cursor -- ONE offset, held OUTSIDE the surface's
 * component tree.
 *
 * Same construction as `filter-store.ts`, for the same reason: THE WALL moves
 * between `inline`, `docked`, `detached` and ambient, and every one of those
 * transitions unmounts and remounts the tree. A cursor held in a provider would
 * snap back to LIVE every time the wall was parked -- silently, and looking
 * exactly like a wall that was never rewound.
 *
 * THE CURSOR IS AN OFFSET, NOT A TIMESTAMP. "42 minutes ago" survives the clock
 * moving; "14:03:11" does not. A pinned absolute instant would drift further
 * into the past every second the wall is left open, so the scrubber would read
 * `T-42m` at one glance and `T-51m` at the next without anybody touching it.
 *
 * Per `feedback_zustand_no_object_selectors`, select ONE field at a time.
 */

import { create } from 'zustand'
import { setWallFrameHold } from '@/hooks/wall-frame-store'

/** How far back the scrubber reaches: three hours, per the card. */
export const WALL_CURSOR_SPAN_MS = 3 * 60 * 60 * 1000

/** One arrow-key press, and the scrubber's granularity. A minute is the unit the
 *  header prints (`T-42m`), so stepping in anything finer would move the slider
 *  without moving the label. */
export const WALL_CURSOR_STEP_MS = 60_000

/** Not exported: every consumer reads the store, and a second name for its shape
 *  is a second thing that can disagree with it. */
interface WallCursorState {
  /** How far behind live the wall is showing, in ms. `0` IS LIVE -- the one
   *  value every pane treats as "no cursor at all". */
  offsetMs: number
  /** Scrub. Clamped to `[0, WALL_CURSOR_SPAN_MS]` and snapped to the step. */
  setOffsetMs(ms: number): void
  /** Nudge by a signed delta -- what the arrow keys call. POSITIVE GOES BACK,
   *  because the offset counts backwards from live and the track counts towards
   *  it. Exactly one file converts between the two (`wall-scrubber.tsx`). */
  step(deltaMs: number): void
  /** Back to LIVE. Releases the frame buffer, which snaps the wall forward. */
  release(): void
}

/** Clamp into the track AND onto the minute grid, in one place: the slider, the
 *  keyboard and `release()` must not be able to produce three different notions
 *  of a valid offset. */
function snap(ms: number): number {
  const clamped = Math.min(WALL_CURSOR_SPAN_MS, Math.max(0, ms))
  return Math.round(clamped / WALL_CURSOR_STEP_MS) * WALL_CURSOR_STEP_MS
}

export const useWallCursorStore = create<WallCursorState>((set, get) => ({
  offsetMs: 0,

  setOffsetMs: ms => {
    const offsetMs = snap(ms)
    if (get().offsetMs === offsetMs) return
    // ORDER MATTERS. The hold is released BEFORE the offset is published, so the
    // buffered frames are folded in while the panes still think they are rewound
    // and the re-render that follows shows the caught-up picture at LIVE. The
    // other order paints one frame of stale-picture-labelled-LIVE.
    setWallFrameHold(offsetMs > 0)
    set({ offsetMs })
  },

  step: deltaMs => get().setOffsetMs(get().offsetMs + deltaMs),
  release: () => get().setOffsetMs(0),
}))
