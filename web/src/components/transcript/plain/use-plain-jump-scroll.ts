/**
 * The plain renderer's half of the transcript-search jump: the actual scroll.
 *
 * Everything before this -- fetching older pages, widening the window, finding
 * which group holds the seq -- is renderer-agnostic and lives in
 * use-transcript-jump.ts. All that is left here is "put that group on screen",
 * which in a non-virtualized tree is a DOM lookup and scrollIntoView.
 *
 * This is a legitimate FOURTH scroll writer (see the list in
 * use-plain-transcript.ts) and the only one driven by an explicit user request
 * rather than by content movement. It runs exactly once per jump, after follow
 * has been switched off, so it can never fight the follow engine for the
 * bottom.
 */

import { type RefObject, useEffect } from 'react'

export function usePlainJumpScroll(
  contentRef: RefObject<HTMLElement | null>,
  groupKey: string | null,
  onLanded: () => void,
): void {
  useEffect(() => {
    if (!groupKey) return
    const root = contentRef.current
    if (!root) return
    // CSS.escape: group keys are stable ids, not guaranteed to be attribute-safe.
    const el = root.querySelector(`[data-group-key="${CSS.escape(groupKey)}"]`)
    if (!el) {
      // Rendered but not yet in the DOM for this commit -- the next render with
      // the same groupKey re-runs this effect.
      console.debug(`[jump] group ${groupKey} not in the DOM yet`)
      return
    }
    console.debug(`[jump] scrolling to group ${groupKey}`)
    el.scrollIntoView({ block: 'center', behavior: 'auto' })
    onLanded()
  }, [groupKey, contentRef, onLanded])
}
