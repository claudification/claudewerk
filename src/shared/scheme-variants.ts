/**
 * The "scheme" look -- a polished, presentation-grade box preset distilled from a
 * hand-tuned reference (the GATE-sign diagram). A box with a `variant` (or title/subtitle)
 * renders as: a soft pastel fill, a thin near-black SKETCHY border (roughness 1, the warmth),
 * a big ink title, and a small grey subtitle, in Nunito.
 *
 * Authored in STANDARD LIGHT hexes on purpose: the dark canvas inverts + hue-rotates them
 * into correct pastels (the `draw.colors` covenant), so one light recipe covers BOTH themes.
 * Pure data + guards; no Excalidraw runtime.
 */
import type { SchemeVariant } from './draw-dsl'

/** Style.font name -> Excalidraw fontFamily id (5 Excalifont = the modern hand-drawn font,
 * 6 Nunito = the clean sans the scheme look uses). Shared by the skeleton + scheme-box passes. */
export const FONT_FAMILY: Record<string, number> = { hand: 1, normal: 2, code: 3, excalifont: 5, nunito: 6 }

/** Shared look constants -- the same for every variant; only the fill hue changes. */
export const SCHEME_RECIPE = {
  stroke: '#1e1e1e',
  titleColor: '#1e1e1e',
  subColor: '#868e96',
  roughness: 1 as const,
  roundnessType: 3 as const,
  titleFont: 6, // Nunito
  subFont: 6, // Nunito
  titlePx: 22,
  subPx: 14,
  /** Stacked title+subtitle line gap (px). */
  lineGap: 7,
  /** Min inner breathing room used by the measure pass. */
  padX: 30,
  padY: 26,
  /** Rough Nunito glyph advance as a fraction of font size -- drives box width + centering
   * (the same constant on both sides keeps text centered within the box). Generous so text
   * never overflows; the slack becomes centering margin. */
  glyphW: 0.55,
} as const

/** Per-variant pastel fill (light hexes; the dark filter handles dark mode). */
export const SCHEME_FILLS: Record<SchemeVariant, string> = {
  blue: '#e7f0ff',
  gold: '#fdf2d6',
  green: '#e6f7ec',
  rose: '#fbe9ee',
  steel: '#eef1f6',
  plain: '#ffffff',
}

/** A box renders in the scheme look when it carries any of variant / title / subtitle. */
export function isSchemeBox(node: { variant?: unknown; title?: unknown; subtitle?: unknown }): boolean {
  return node.variant !== undefined || node.title !== undefined || node.subtitle !== undefined
}

/** Line heights + stacked title/subtitle block height -- shared by the emitter (positioning)
 * and the measure pass (box height), so the two never drift. */
export function schemeBlock(title: string, sub: string): { titleH: number; subH: number; blockH: number } {
  const R = SCHEME_RECIPE
  const titleH = title ? R.titlePx * 1.25 : 0
  const subH = sub ? R.subPx * 1.25 : 0
  return { titleH, subH, blockH: titleH + (title && sub ? R.lineGap : 0) + subH }
}
