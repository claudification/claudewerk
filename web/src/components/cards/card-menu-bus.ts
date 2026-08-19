/**
 * Card-link context-menu bus. Non-component module (Fast-Refresh clean) so both
 * card renderers can raise the menu without importing the menu chunk.
 *
 * A card link has TWO renderers -- `CardChip` (React) and the `a.file-link-card`
 * anchor the markdown renderer paints as a raw HTML string. Wrapping each one in
 * its own Radix `ContextMenu.Trigger` is impossible for the second (there is no
 * React element to clone) and would be two menu definitions for the first, which
 * is exactly the drift `cardGlyph()` exists to prevent. So neither renderer owns
 * a menu: they report a POINT and a card, and one singleton layer draws it.
 *
 * `armed` latches on the first right-click and gates the lazy chunk -- a session
 * that never right-clicks a card never downloads the menu at all.
 */

import { create } from 'zustand'
import type { CardRef } from '@/lib/cards'

export interface CardMenuTarget {
  ref: CardRef
  /** The path the link carried, verbatim -- what COPY PATH copies. */
  path: string
  /** Viewport coordinates of the click, for the floating anchor. */
  x: number
  y: number
}

interface CardMenuState {
  /** Latches true on the first right-click -- the lazy-chunk trigger. */
  armed: boolean
  target: CardMenuTarget | null
  show: (target: CardMenuTarget) => void
  hide: () => void
}

export const useCardMenu = create<CardMenuState>(set => ({
  armed: false,
  target: null,
  show: target => set({ armed: true, target }),
  hide: () => set({ target: null }),
}))

export function openCardMenu(target: CardMenuTarget): void {
  useCardMenu.getState().show(target)
}

export function closeCardMenu(): void {
  if (useCardMenu.getState().target) useCardMenu.getState().hide()
}
