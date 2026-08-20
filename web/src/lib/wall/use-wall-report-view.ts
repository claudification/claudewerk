/**
 * WHAT THE WALL WAS BEING READ AT, for a pane about to stamp a report.
 *
 * Two primitives off two stores, assembled here so twelve panes do not each
 * write the same pair of selectors -- and so a pane cannot stamp one and forget
 * the other, which would produce a report claiming to be a view of `now` while
 * the scrubber sat at `T-42m`.
 *
 * Both selectors return PRIMITIVES, per `feedback_zustand_no_object_selectors`:
 * a selector returning `{ offsetMs, filter }` builds a new object on every store
 * write and re-renders every pane that calls this on every keystroke.
 */

import { useWallCursorStore } from './cursor-store'
import { useWallFilterStore } from './filter-store'
import type { WallReportView } from './report'

export function useWallReportView(): WallReportView {
  const offsetMs = useWallCursorStore(s => s.offsetMs)
  const filter = useWallFilterStore(s => s.raw)
  return { offsetMs, filter }
}
