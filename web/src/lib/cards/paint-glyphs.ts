/**
 * Paint the inline status glyph onto card links inside a rendered markdown
 * block. Imperative on purpose: the anchors are marked-produced HTML injected
 * with `dangerouslySetInnerHTML`, so there is no React node to re-render.
 *
 * The glyph is the whole affordance -- SQUARE for a card, DIAMOND for an epic
 * (filled once it is complete), a spinner while the backend is still answering,
 * `?` when nobody claims the id. Colour comes from the canonical state via CSS
 * (`a.file-link-card[data-card-state=...]`), never inline styles.
 */

import { matchCardHref, peekCard } from './registry'
import type { CardLookup, CardRef } from './types'

export const CARD_GLYPH = { card: '▪', epic: '◈', epicDone: '◆', resolving: '◜', unknown: '?' } as const

/** Non-ready lookups: what the glyph says and which state class it wears. */
const PENDING_GLYPH: Record<string, { glyph: string; state: string }> = {
  resolving: { glyph: CARD_GLYPH.resolving, state: 'resolving' },
  unknown: { glyph: CARD_GLYPH.unknown, state: 'unknown' },
  unavailable: { glyph: CARD_GLYPH.card, state: 'offline' },
}

function applyLookup(node: HTMLElement, glyph: HTMLElement, lookup: CardLookup): void {
  if (lookup.status !== 'ready') {
    const pending = PENDING_GLYPH[lookup.status] ?? PENDING_GLYPH.resolving
    node.dataset.cardState = pending.state
    node.dataset.cardKind = 'card'
    glyph.textContent = pending.glyph
    return
  }
  const { state, kind, progress } = lookup.summary
  node.dataset.cardState = state
  node.dataset.cardKind = kind
  const complete = kind === 'epic' && progress?.pct === 100
  glyph.textContent = complete ? CARD_GLYPH.epicDone : CARD_GLYPH[kind]
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
