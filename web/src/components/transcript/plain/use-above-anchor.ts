/**
 * Scroll-anchoring polyfill for the plain renderer's DETACHED reader.
 *
 * FALLBACK PATH ONLY -- runs where the engine has no native scroll anchoring
 * (Safari 26 and older); anchor-strategy.ts stands it down everywhere else,
 * because native anchoring plus this would double-compensate. Where it does
 * run: when a `content-visibility` group ABOVE the viewport inflates from its
 * reserved `contain-intrinsic-size` to its real height (which happens exactly
 * as the reader scrolls up toward it), everything below shifts down and the
 * reader's position dies -- the scroll-up teleport. The prepend anchor can't
 * help: it compensates the INSERTION delta only, not the later inflation.
 *
 * Accurate per-group reserved heights (use-group-heights.ts) shrink the
 * inflation this has to chase; they do not remove it, because a first-ever
 * encounter is still an estimate.
 *
 * How: one ResizeObserver over every group box. When a box whose previous
 * extent sat fully above the viewport top changes height while the engine is
 * not at the raw bottom, scrollTop shifts by the delta -- through the
 * engine's tagged setter (ONE-WRITER invariant: the write sets
 * ignoreScrollToTop, so it can never read as user intent), inside the RO
 * callback (post-layout, pre-paint), so the reader never sees the jump. At
 * the raw bottom the engine's own resize pin owns positioning -- stand down.
 * A box's first observation only records its baseline (its insertion delta
 * belongs to the prepend anchor).
 */

import { useEffect } from 'react'
import type { useStickToBottom } from 'use-stick-to-bottom'
import { observeGroupBoxes } from './group-box-observer'

type Engine = ReturnType<typeof useStickToBottom>

/** One resized group box: the element plus its NEW border-box height. */
export interface ResizedBox {
  el: HTMLElement
  newH: number
}

function toResizedBox(entry: ResizeObserverEntry): ResizedBox {
  const el = entry.target as HTMLElement
  return { el, newH: entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight }
}

/** Document-order sort. ResizeObserver delivers in observe() order, and the
 *  MutationObserver path (groups mounting as the window moves) makes that
 *  diverge from document order -- which the running-shift walk below depends
 *  on. */
function inDocumentOrder(boxes: ResizedBox[]): ResizedBox[] {
  return [...boxes].sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
}

/**
 * Total scrollTop compensation for one batch of resized boxes, updating each
 * box's baseline in `heights` on the way through (a box's first observation is
 * baseline only -- its insertion delta belongs to the prepend anchor).
 *
 * THE BATCH TRAP: the callback runs post-layout, so a box's `rect.top` has
 * ALREADY been pushed down by every earlier sibling that grew in the same
 * batch. Testing that contaminated top against the viewport misclassifies a
 * genuinely-above box as straddling and silently drops its delta -- the reader
 * jumps by exactly that much. So we walk in document order, carry the running
 * `shift` those earlier siblings contributed, and subtract it to recover the
 * box's PRE-resize top. `shift` accumulates for every changed box, compensated
 * or not: layout pushed the ones below down either way.
 *
 * A box's own top is unmoved by its own growth, so preTop + oldH is its
 * pre-resize bottom edge. Fully above the scroller's top edge -> the growth
 * happened above the reader and must be compensated. A straddling or visible
 * box is its own anchor (its top stays put) -- no shift.
 */
export function compensationForBatch(
  boxes: ResizedBox[],
  heights: WeakMap<Element, number>,
  scrollerTop: number,
): number {
  let shift = 0
  let delta = 0
  for (const { el, newH } of inDocumentOrder(boxes)) {
    const oldH = heights.get(el)
    heights.set(el, newH)
    if (oldH === undefined || oldH === newH) continue
    const preTop = el.getBoundingClientRect().top - shift
    if (preTop + oldH <= scrollerTop + 1) delta += newH - oldH
    shift += newH - oldH
  }
  return delta
}

export function useAboveViewportAnchor(engine: Engine, enabled = true): void {
  const { scrollRef, contentRef, state } = engine
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs + state are stable engine identities; `enabled` re-runs on toggle
  useEffect(() => {
    if (!enabled) return // Plain Renderer Lab: above-viewport anchor disabled.
    const content = contentRef.current
    const scroller = scrollRef.current
    if (!content || !scroller) return
    const heights = new WeakMap<Element, number>()
    return observeGroupBoxes(content, entries => {
      // At the raw bottom the engine's resize pin owns positioning -- walk the
      // batch anyway so baselines stay fresh, but discard the compensation.
      const atBottom = state.isAtBottom
      const scrollerTop = atBottom ? 0 : scroller.getBoundingClientRect().top
      const batch = compensationForBatch(entries.map(toResizedBox), heights, scrollerTop)
      const delta = atBottom ? 0 : batch
      if (delta !== 0) {
        state.scrollTop = state.scrollTop + delta
        console.debug(`[window] above-anchor (plain) ${delta > 0 ? '+' : ''}${Math.round(delta)}px`)
      }
    })
  }, [enabled])
}
