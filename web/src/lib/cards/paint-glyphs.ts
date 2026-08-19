/**
 * Paint the inline status glyph onto card links inside a rendered markdown
 * block. Imperative on purpose: the anchors are marked-produced HTML injected
 * with `dangerouslySetInnerHTML`, so there is no React node to re-render.
 *
 * The glyph is the whole affordance -- SQUARE for a card, DIAMOND for an epic
 * (filled once it is complete), a spinner while the backend is still answering,
 * `?` when nobody claims the id. Which glyph goes with which lookup lives in
 * `glyph.ts`, shared with the React `CardChip`. Colour comes from the canonical
 * state via CSS (`a.file-link-card[data-card-state=...]`), never inline styles.
 */

import { cardGlyph } from './glyph'
import { matchCardHref, peekCard } from './registry'
import type { CardLookup, CardRef } from './types'

export { CARD_GLYPH } from './glyph'

function applyLookup(node: HTMLElement, glyph: HTMLElement, lookup: CardLookup): void {
  const view = cardGlyph(lookup)
  node.dataset.cardState = view.dataState
  node.dataset.cardKind = view.kind
  glyph.textContent = view.glyph
}

/** Paint every card link under `root`; returns the refs found, for resolving. */
export function paintCardGlyphs(root: HTMLElement): CardRef[] {
  const refs: CardRef[] = []
  for (const node of root.querySelectorAll<HTMLAnchorElement>('a.file-link-card')) {
    const path = node.getAttribute('data-file-path')
    const ref = path ? matchCardHref(path) : null
    if (!ref) continue
    refs.push(ref)
    const glyph = node.querySelector<HTMLElement>('.card-glyph')
    if (glyph) applyLookup(node, glyph, peekCard(ref))
  }
  return refs
}
