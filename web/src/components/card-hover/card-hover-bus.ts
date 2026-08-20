/**
 * The app's ONE hover bus. Non-component module (Fast-Refresh clean) so the
 * markdown renderer can arm the hover without importing the panel chunk.
 *
 * The OPEN DELAY lives here, not in the layer: dragging the pointer across a
 * paragraph with six card links must not queue six fetches and six panels.
 * `armed` latches on first hover and gates the lazy chunk -- a session that
 * never hovers anything never downloads the hover card at all.
 *
 * THREE CONTENTS, ONE LAYER. It started as card links only, then THE WALL
 * needed previews on pulse, commit and ledger rows, whose card said in writing:
 * do not write a third popover system. So the bus carries a CONTENT union and
 * the layer picks a body, rather than each surface growing its own floating
 * layer with its own geometry, its own dismissal rules and its own bugs.
 *
 * TOUCH NEVER OPENS ONE, and the gate is at the POINTER call site rather than
 * in `openHover`. Card chips also open on FOCUS, which is the keyboard path and
 * must keep working on a device that cannot hover at all -- a gate down here
 * would take that out with the tap.
 */

import { create } from 'zustand'
import type { CardRef } from '@/lib/cards'
import type { HoverFacts } from './hover-facts'

const CARD_HOVER_DELAY_MS = 160

/** What the layer is being asked to show. */
export type HoverContent =
  /** A board card, resolved through the card provider seam. */
  | { kind: 'card'; ref: CardRef }
  /** One commit -- full message and file stats, fetched on open. */
  | { kind: 'commit'; hash: string }
  /** Already-answered facts the caller computed. See `hover-facts.ts`. */
  | { kind: 'facts'; facts: HoverFacts }

interface CardHoverState {
  /** Latches true on the first hover -- the lazy-chunk trigger. */
  armed: boolean
  content: HoverContent | null
  anchor: HTMLElement | null
  show: (content: HoverContent, anchor: HTMLElement) => void
  hide: () => void
}

export const useCardHover = create<CardHoverState>(set => ({
  armed: false,
  content: null,
  anchor: null,
  show: (content, anchor) => set({ armed: true, content, anchor }),
  hide: () => set({ content: null, anchor: null }),
}))

let openTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Does this pointer hover at all?
 *
 * A touch tap synthesises `mouseenter`, so without this a phone gets a panel it
 * never asked for and cannot dismiss by moving away. `matchMedia` is the
 * question actually being asked ("can this input hover"), rather than sniffing
 * the user agent for a proxy of it. Absent `matchMedia` (jsdom, an old WebView)
 * is treated as a hovering pointer: the mouse path is the one that has to keep
 * working, and a stray panel on an exotic browser beats a dead affordance on a
 * real one.
 */
export function canHover(view: Window = window): boolean {
  if (typeof view.matchMedia !== 'function') return true
  return !view.matchMedia('(hover: none)').matches
}

/** Queue the panel for `anchor`. Re-hovering the open anchor is a no-op. */
export function openHover(content: HoverContent, anchor: HTMLElement): void {
  if (useCardHover.getState().anchor === anchor) return
  clearTimeout(openTimer)
  openTimer = setTimeout(() => useCardHover.getState().show(content, anchor), CARD_HOVER_DELAY_MS)
}

/** Queue the card-link panel. The original caller, kept as its own verb. */
export function openCardHover(ref: CardRef, anchor: HTMLElement): void {
  openHover({ kind: 'card', ref }, anchor)
}

/** Queue a commit preview -- message body plus the file stat summary. */
export function openCommitHover(hash: string, anchor: HTMLElement): void {
  openHover({ kind: 'commit', hash }, anchor)
}

/** Queue a preview the caller already has every answer for. */
export function openFactsHover(facts: HoverFacts, anchor: HTMLElement): void {
  openHover({ kind: 'facts', facts }, anchor)
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
