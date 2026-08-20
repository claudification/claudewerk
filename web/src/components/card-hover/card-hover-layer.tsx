/**
 * The floating layer for hover previews -- card links, commits, and rows that
 * hand over their own facts.
 *
 * Card links are raw anchors inside `dangerouslySetInnerHTML` markdown, so the
 * generic `<HoverCard>` (which wraps a React trigger) cannot be used -- but the
 * geometry is the same rule, so `computeHoverCoords` is shared rather than
 * re-derived. Closing is pointer-based: anything that is neither the anchor nor
 * the panel takes it down, as does a scroll, a resize or Escape.
 *
 * IT FOLLOWS THE ANCHOR INTO ANOTHER WINDOW. THE WALL detaches into a popup and
 * its DOM lives in that popup's document, so a layer hardcoded to `document.body`
 * and `window.innerWidth` would portal a wall row's preview into the DASHBOARD,
 * behind the popup you are looking at, positioned against the wrong viewport.
 * Every reference here is taken from `anchor.ownerDocument` instead, which is
 * the same window in the ordinary case and the right one in the detached case.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CommitHoverPanel } from '@/components/commits/commit-hover-panel'
import { computeHoverCoords, type HoverCoords } from '@/components/ui/hover-card-position'
import { closeCardHover, type HoverContent, useCardHover } from './card-hover-bus'
import { CardHoverPanel } from './card-hover-panel'
import { HoverFactsPanel } from './hover-facts-panel'

const PANEL_WIDTH = 320

function HoverBody({ content }: { content: HoverContent }) {
  if (content.kind === 'card') return <CardHoverPanel cardRef={content.ref} />
  if (content.kind === 'commit') return <CommitHoverPanel hash={content.hash} />
  return <HoverFactsPanel facts={content.facts} />
}

// fallow-ignore-next-line unused-export -- mounted through lazyModule(named(...)) in app.tsx
export function CardHoverLayer() {
  const content = useCardHover(s => s.content)
  const anchor = useCardHover(s => s.anchor)
  const [coords, setCoords] = useState<HoverCoords | null>(null)

  useEffect(() => {
    if (!anchor) {
      setCoords(null)
      return
    }
    const view = anchor.ownerDocument.defaultView ?? window
    const rect = anchor.getBoundingClientRect()
    setCoords(computeHoverCoords(rect, { width: view.innerWidth, height: view.innerHeight }, PANEL_WIDTH))
  }, [anchor])

  useEffect(() => {
    if (!anchor) return
    const doc = anchor.ownerDocument
    const view = doc.defaultView ?? window
    // The panel is portaled as a SIBLING of the anchor's subtree, so it cannot
    // be reached from the anchor -- `pointerover` on it must not close it.
    const onPointerOver = (e: Event) => {
      const target = e.target as Element | null
      if (!target) return
      if (anchor.contains(target) || target.closest('[data-hover-panel]')) return
      closeCardHover()
    }
    const onDismiss = () => closeCardHover()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeCardHover()
    }
    doc.addEventListener('pointerover', onPointerOver, true)
    view.addEventListener('scroll', onDismiss, true)
    view.addEventListener('resize', onDismiss)
    doc.addEventListener('keydown', onKey)
    return () => {
      doc.removeEventListener('pointerover', onPointerOver, true)
      view.removeEventListener('scroll', onDismiss, true)
      view.removeEventListener('resize', onDismiss)
      doc.removeEventListener('keydown', onKey)
    }
  }, [anchor])

  if (!content || !anchor || !coords) return null

  return createPortal(
    <div
      data-hover-panel=""
      role="tooltip"
      style={{ position: 'fixed', left: coords.left, top: coords.top, bottom: coords.bottom, width: PANEL_WIDTH }}
      className="z-[120]"
    >
      <div
        style={{ maxHeight: coords.maxHeight }}
        className="overflow-y-auto rounded-md bg-background/95 shadow-xl backdrop-blur border border-border"
      >
        <HoverBody content={content} />
      </div>
    </div>,
    anchor.ownerDocument.body,
  )
}
