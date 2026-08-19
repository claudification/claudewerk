/**
 * What a card lookup LOOKS like -- one table, two renderers.
 *
 * The markdown renderer paints its glyphs imperatively onto marked-produced
 * HTML (`paint-glyphs.ts`), the tool lines render a React chip (`CardChip`).
 * Neither may invent its own glyph or its own idea of which state a still-
 * resolving card is in, so both ask here.
 *
 * `dataState` is the CSS hook (it carries the pseudo-states `resolving` and
 * `offline` that no card is actually IN); `state` is the canonical state used
 * for colour lookups in `CARD_STATE_STYLE`.
 */

import type { CardKind, CardLookup, CardState } from './types'

/** SQUARE for a card, DIAMOND for an epic (filled once complete). */
export const CARD_GLYPH = { card: '▪', epic: '◈', epicDone: '◆', resolving: '◜', unknown: '?' } as const

export interface CardGlyphView {
  glyph: string
  /** `data-card-state` value: a canonical state, or `resolving` / `offline`. */
  dataState: string
  /** Canonical state, for `CARD_STATE_STYLE`. Pending lookups read `unknown`. */
  state: CardState
  kind: CardKind
}

/** Lookups that are not `ready` -- nothing is known yet, so kind is `card`. */
const PENDING: Record<string, CardGlyphView> = {
  resolving: { glyph: CARD_GLYPH.resolving, dataState: 'resolving', state: 'unknown', kind: 'card' },
  unknown: { glyph: CARD_GLYPH.unknown, dataState: 'unknown', state: 'unknown', kind: 'card' },
  unavailable: { glyph: CARD_GLYPH.card, dataState: 'offline', state: 'unknown', kind: 'card' },
}

export function cardGlyph(lookup: CardLookup): CardGlyphView {
  if (lookup.status !== 'ready') return PENDING[lookup.status] ?? PENDING.resolving
  const { state, kind, progress } = lookup.summary
  const complete = kind === 'epic' && progress?.pct === 100
  return { glyph: complete ? CARD_GLYPH.epicDone : CARD_GLYPH[kind], dataState: state, state, kind }
}
