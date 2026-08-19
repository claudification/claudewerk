/**
 * Card-link hover bus. Non-component module (Fast-Refresh clean) so the
 * markdown renderer can arm the hover without importing the panel chunk.
 *
 * The OPEN DELAY lives here, not in the layer: dragging the pointer across a
 * paragraph with six card links must not queue six fetches and six panels.
 * `armed` latches on first hover and gates the lazy chunk -- a session that
 * never hovers a card never downloads the hover card at all.
 */

import { create } from 'zustand'
import type { CardRef } from '@/lib/cards'

const CARD_HOVER_DELAY_MS = 160

interface CardHoverState {
  /** Latches true on the first hover -- the lazy-chunk trigger. */
  armed: boolean
  ref: CardRef | null
  anchor: HTMLElement | null
  show: (ref: CardRef, anchor: HTMLElement) => void
  hide: () => void
}

export const useCardHover = create<CardHoverState>(set => ({
  armed: false,
  ref: null,
  anchor: null,
  show: (ref, anchor) => set({ armed: true, ref, anchor }),
  hide: () => set({ ref: null, anchor: null }),
}))

let openTimer: ReturnType<typeof setTimeout> | undefined

/** Queue the panel for `anchor`. Re-hovering the open anchor is a no-op. */
export function openCardHover(ref: CardRef, anchor: HTMLElement): void {
  if (useCardHover.getState().anchor === anchor) return
  clearTimeout(openTimer)
  openTimer = setTimeout(() => useCardHover.getState().show(ref, anchor), CARD_HOVER_DELAY_MS)
}

/** Cancel a queued open and shut anything showing. */
export function closeCardHover(): void {
  clearTimeout(openTimer)
  if (useCardHover.getState().anchor) useCardHover.getState().hide()
}

/**
 * Shut the panel only if `anchor` is the element it is pointing at.
 *
 * For unmount cleanup: transcript rows are virtualized, so a chip can leave the
 * DOM while its own panel is open (which would then hang off a detached node)
 * -- but ALSO while a DIFFERENT card's panel is open, and closing that one is a
 * panel that vanishes under the pointer.
 */
export function closeCardHoverFor(anchor: HTMLElement | null): void {
  if (anchor && useCardHover.getState().anchor === anchor) closeCardHover()
}
