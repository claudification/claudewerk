/**
 * The floating layer for card-link hovers.
 *
 * Card links are raw anchors inside `dangerouslySetInnerHTML` markdown, so the
 * generic `<HoverCard>` (which wraps a React trigger) cannot be used -- but the
 * geometry is the same rule, so `computeHoverCoords` is shared rather than
 * re-derived. Closing is pointer-based: anything that is neither the anchor nor
 * the panel takes it down, as does a scroll, a resize or Escape.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { computeHoverCoords, type HoverCoords } from '@/components/ui/hover-card-position'
import { closeCardHover, useCardHover } from './card-hover-bus'
import { CardHoverPanel } from './card-hover-panel'

const PANEL_WIDTH = 320

// fallow-ignore-next-line unused-export -- mounted through lazyModule(named(...)) in app.tsx
export function CardHoverLayer() {
  const cardRef = useCardHover(s => s.ref)
  const anchor = useCardHover(s => s.anchor)
  const panelRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<HoverCoords | null>(null)

  useEffect(() => {
    if (!anchor) {
      setCoords(null)
      return
    }
    const rect = anchor.getBoundingClientRect()
    setCoords(computeHoverCoords(rect, { width: window.innerWidth, height: window.innerHeight }, PANEL_WIDTH))
  }, [anchor])

  useEffect(() => {
    if (!anchor) return
    const onPointerOver = (e: Event) => {
      const target = e.target as Node | null
      if (!target) return
      if (anchor.contains(target) || panelRef.current?.contains(target)) return
      closeCardHover()
    }
    const onDismiss = () => closeCardHover()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeCardHover()
    }
    document.addEventListener('pointerover', onPointerOver, true)
    window.addEventListener('scroll', onDismiss, true)
    window.addEventListener('resize', onDismiss)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerover', onPointerOver, true)
      window.removeEventListener('scroll', onDismiss, true)
      window.removeEventListener('resize', onDismiss)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchor])

  if (!cardRef || !coords) return null

  return createPortal(
    <div
      ref={panelRef}
      role="tooltip"
      style={{ position: 'fixed', left: coords.left, top: coords.top, bottom: coords.bottom, width: PANEL_WIDTH }}
      className="z-[120]"
    >
      <div
        style={{ maxHeight: coords.maxHeight }}
        className="overflow-y-auto rounded-md bg-background/95 shadow-xl backdrop-blur border border-border"
      >
        <CardHoverPanel cardRef={cardRef} />
      </div>
    </div>,
    document.body,
  )
}
