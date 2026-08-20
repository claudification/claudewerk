/**
 * `useWallCursor()` -- THE W1 CONTRACT SYMBOL, and the one call anything on the
 * wall makes to find out WHEN it is being read at.
 *
 * Panes do not normally call it. Row narrowing rides `useWallFilter`, which
 * every pane already calls, so a pane obeys the cursor without knowing it exists
 * -- see `use-wall-filter.ts` for why that is the seam. This hook is for the
 * things that must render the cursor rather than obey it: the header scrubber,
 * the pane chrome's rewound treatment, and the two series panes (S1, S2) that
 * have to look a value up at the offset instead of dropping rows.
 *
 * It returns three PRIMITIVES rather than an object off a selector, per
 * `feedback_zustand_no_object_selectors`: each field is selected on its own and
 * the object is assembled here, so a render is driven by the field that changed.
 */

import { useWallCursorStore } from './cursor-store'
import { formatCursorOffset } from './cursor'

export interface WallCursor {
  /** ms behind live. `0` IS LIVE. */
  offsetMs: number
  /** `offsetMs > 0` -- the wall is showing the past. */
  rewound: boolean
  /** What the header prints: `LIVE` or `T-42m`. */
  label: string
}

export function useWallCursor(): WallCursor {
  const offsetMs = useWallCursorStore(s => s.offsetMs)
  return { offsetMs, rewound: offsetMs > 0, label: formatCursorOffset(offsetMs) }
}
