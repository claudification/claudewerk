/**
 * Scroll-anchoring polyfill for the plain renderer's DETACHED reader.
 *
 * Why: Safari has no native scroll anchoring, and Chrome's is deliberately
 * disabled on the scroller (`overflow-anchor: none` -- it would
 * double-compensate the prepend anchor). So when a `content-visibility` group
 * ABOVE the viewport inflates from its 200px `contain-intrinsic-size`
 * estimate to its real height (which happens exactly as the reader scrolls up
 * toward it), everything below shifts down and the reader's position dies --
 * the scroll-up teleport. The prepend anchor can't help: it compensates the
 * INSERTION delta only, not the later estimate->real inflation.
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

type Engine = ReturnType<typeof useStickToBottom>

const GROUP_SELECTOR = '.transcript-plain-group'

/** Height delta of one resized box that must be compensated, or 0. Updates the
 *  baseline in `heights` either way (a box's first observation is baseline
 *  only -- its insertion delta belongs to the prepend anchor). The box's own
 *  top is unmoved by its own growth, so top + oldH is its pre-resize bottom
 *  edge: fully above the viewport -> the growth happened above the reader and
 *  must be compensated. A straddling or visible box is its own anchor (its
 *  top stays put) -- no shift. */
function compensableDelta(entry: ResizeObserverEntry, heights: WeakMap<Element, number>, scrollerTop: number): number {
  const el = entry.target as HTMLElement
  const newH = entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight
  const oldH = heights.get(el)
  heights.set(el, newH)
  if (oldH === undefined || oldH === newH) return 0
  return el.getBoundingClientRect().top + oldH <= scrollerTop + 1 ? newH - oldH : 0
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
    const ro = new ResizeObserver(entries => {
      // At the raw bottom the engine's resize pin owns positioning -- record
      // fresh baselines only.
      const atBottom = state.isAtBottom
      const scrollerTop = atBottom ? 0 : scroller.getBoundingClientRect().top
      let delta = 0
      for (const entry of entries) {
        const d = compensableDelta(entry, heights, scrollerTop)
        if (!atBottom) delta += d
      }
      if (delta !== 0) {
        state.scrollTop = state.scrollTop + delta
        console.debug(`[window] above-anchor (plain) ${delta > 0 ? '+' : ''}${Math.round(delta)}px`)
      }
    })
    for (const el of content.querySelectorAll(GROUP_SELECTOR)) ro.observe(el)
    // Groups mount/unmount as the window moves -- track them via mutations.
    // Dead nodes drop out of the RO + WeakMap automatically.
    const mo = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (node.matches(GROUP_SELECTOR)) ro.observe(node)
          for (const el of node.querySelectorAll(GROUP_SELECTOR)) ro.observe(el)
        }
      }
    })
    mo.observe(content, { childList: true, subtree: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [enabled])
}
