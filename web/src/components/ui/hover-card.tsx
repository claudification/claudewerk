import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { DEFAULT_PANEL_WIDTH } from './hover-card-position'
import { HOVER_OPEN_DELAY_MS, useHoverCard } from './use-hover-card'

/**
 * THE hover card shell -- ONE implementation of the hard parts, for every
 * floating detail panel in the app (status detail, RUN card, PLACE card):
 *
 * - portals to `document.body` so dense list rows cannot clip it
 * - opens on a deliberate delay so scanning a roster doesn't spam panels
 * - fixed-positioned at the trigger rect, flipping above when there's no room
 * - stays open while the pointer is over the trigger OR the panel (links stay
 *   reachable), closes on leave / scroll / resize / Escape
 * - `openOnTap` for touch, where hover does not exist: tap toggles, an outside
 *   tap dismisses, and propagation stops so the row underneath isn't selected
 *
 * If the delay or the flip logic ever ends up in a second file, that is the bug.
 */

export interface HoverCardProps {
  /** Panel body. A thunk, not a node: nothing is built while the card is shut. */
  panel: () => ReactNode
  width?: number
  openDelayMs?: number
  /** Tap toggles the panel (touch has no hover). Off by default -- turning it on
   *  makes the trigger swallow clicks, which a badge inside a clickable row
   *  must not do unless it is a deliberate affordance. */
  openOnTap?: boolean
  className?: string
  panelClassName?: string
  /** A render-prop trigger gets `close` -- for a trigger that opens something of
   *  its own (a modal), which would otherwise render UNDER the floating panel. */
  children: ReactNode | ((api: { close: () => void; isOpen: boolean }) => ReactNode)
}

export function HoverCard({
  panel,
  width = DEFAULT_PANEL_WIDTH,
  openDelayMs = HOVER_OPEN_DELAY_MS,
  openOnTap = false,
  className,
  panelClassName,
  children,
}: HoverCardProps) {
  const { coords, triggerRef, panelRef, open, close, cancelClose } = useHoverCard(width, openDelayMs, openOnTap)

  function onTriggerClick(e: React.MouseEvent) {
    // Without openOnTap the click belongs to whatever the trigger wraps (a
    // button that opens a dialog, a row that selects) -- we only get out of the
    // way by dismissing the panel, and let the event through untouched.
    if (!openOnTap) {
      close(true)
      return
    }
    e.stopPropagation()
    e.preventDefault()
    if (coords) close(true)
    else open(true)
  }

  return (
    <>
      {/* The trigger wraps arbitrary (often already interactive) content, so it
          stays a span -- a tap affordance passes its own button in as children. */}
      {/* react-doctor-disable-next-line react-doctor/prefer-tag-over-role */}
      <span
        ref={triggerRef}
        className={cn('inline-flex items-center gap-1', className)}
        onMouseEnter={() => open()}
        onMouseLeave={() => close()}
        onFocus={() => open()}
        onBlur={() => close(true)}
        onClick={onTriggerClick}
      >
        {typeof children === 'function' ? children({ close: () => close(true), isOpen: !!coords }) : children}
      </span>
      {coords &&
        createPortal(
          <div
            ref={panelRef}
            role="tooltip"
            style={{ position: 'fixed', left: coords.left, top: coords.top, bottom: coords.bottom, width }}
            className="z-[120]"
            onMouseEnter={cancelClose}
            onMouseLeave={() => close()}
          >
            <div
              style={{ maxHeight: coords.maxHeight }}
              className={cn(
                'overflow-y-auto rounded-md bg-background/95 shadow-xl backdrop-blur border border-border/60',
                panelClassName,
              )}
            >
              {panel()}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
