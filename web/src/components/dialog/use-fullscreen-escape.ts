/**
 * Let an in-flow element go TRUE-viewport fullscreen (position:fixed; inset:0) without
 * portaling it elsewhere in the DOM. Why not just portal? The Draw block hosts an
 * Excalidraw canvas; moving it across a portal boundary REMOUNTS it, which re-seeds the
 * scene and RESETS the user's pan/zoom on every fullscreen toggle. Keeping the element
 * where it is means the canvas never remounts -> the toggle is instant and the viewport
 * is preserved.
 *
 * The catch: an ancestor with transform / filter / backdrop-filter / perspective creates
 * a containing block, so a `fixed` descendant resolves to that ancestor, not the viewport
 * (proven live: a fixed inset-0 probe inside the dialog card clipped to the card, because
 * the card uses backdrop-filter; a one-shot dialog centers via transform). So while
 * fullscreen is active we neutralize those props on every ancestor and restore them on
 * exit. Safe because our fullscreen overlay is opaque and covers the viewport, hiding any
 * ancestor that briefly mispositions; everything is put back verbatim on cleanup.
 */
import { type RefObject, useLayoutEffect } from 'react'

// Props (incl. Safari's prefixed backdrop-filter) that establish a containing block.
const CB_PROPS = ['transform', 'perspective', 'filter', 'backdrop-filter', '-webkit-backdrop-filter'] as const

function createsContainingBlock(el: HTMLElement): boolean {
  const s = getComputedStyle(el)
  const webkit = (s as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter
  return (
    s.transform !== 'none' ||
    s.perspective !== 'none' ||
    s.filter !== 'none' ||
    s.backdropFilter !== 'none' ||
    (!!webkit && webkit !== 'none')
  )
}

export function useFullscreenEscape(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return
    const start = ref.current?.parentElement
    if (!start) return

    const touched: Array<{ el: HTMLElement; prev: Array<[string, string]> }> = []
    for (let el: HTMLElement | null = start; el && el !== document.body; el = el.parentElement) {
      if (!createsContainingBlock(el)) continue
      const prev = CB_PROPS.map(p => [p, el.style.getPropertyValue(p)] as [string, string])
      for (const p of CB_PROPS) el.style.setProperty(p, 'none', 'important')
      touched.push({ el, prev })
    }

    return () => {
      for (const { el, prev } of touched) {
        for (const [p, v] of prev) {
          if (v) el.style.setProperty(p, v)
          else el.style.removeProperty(p)
        }
      }
    }
  }, [active, ref])
}
