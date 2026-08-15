/**
 * An epic hue placed inside the board's existing oklch band.
 *
 * The panel's semantic tokens all live at roughly L .75 / C .15 (`globals.css`).
 * Generating an epic colour with a free hand would produce something that is
 * technically distinct and visibly foreign -- a saturated web-safe green next
 * to the board's muted one. Pinning L and C and varying only the hue means a
 * new epic colour cannot look like it came from a different design.
 *
 * Four roles, because an epic needs to be identifiable at four weights:
 * the rail (solid), the glyph (solid), the tint (a wash behind a header) and
 * the edge (a hairline border).
 */

import type { CSSProperties } from 'react'

/** Lightness/chroma of the board's own accent tokens. Do not free-hand these. */
const L = 0.75
const C = 0.15

export interface EpicColorVars extends CSSProperties {
  '--epic-hue': string
  '--epic-solid': string
  '--epic-tint': string
  '--epic-edge': string
}

/**
 * CSS custom properties for one epic. Spread onto the swimlane root; children
 * then reference `var(--epic-solid)` and inherit without re-deriving.
 */
export function epicColorVars(hue: number): EpicColorVars {
  return {
    '--epic-hue': String(hue),
    '--epic-solid': `oklch(${L} ${C} ${hue})`,
    '--epic-tint': `oklch(${L} ${C} ${hue} / 0.10)`,
    '--epic-edge': `oklch(${L} ${C} ${hue} / 0.35)`,
  }
}
