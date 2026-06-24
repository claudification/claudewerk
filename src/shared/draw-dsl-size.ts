/**
 * Intrinsic sizing constants + rough text metrics for the DSL layout pass. Split out of
 * draw-dsl.ts to keep the type module under the size bar. Pure (no canvas): the metrics are
 * estimates good enough for wireframe layout -- the real glyph widths come from Excalidraw
 * at convert time. Re-exported by draw-dsl.ts so the public surface is unchanged.
 */

// --- intrinsic sizing (no canvas; rough text metrics good enough for wireframes) ---
export const SIZE = {
  box: [160, 60],
  ellipse: [160, 80],
  diamond: [160, 80],
  button: [140, 44],
  inputField: [220, 40],
  checkbox: 24,
  nav: 44,
  image: [220, 140],
  mermaid: [360, 260],
  gap: 24,
  pad: 20,
  titleBar: 30,
  charW: 8.5,
  lineH: 22,
} as const

const FONT_PX = { s: 16, m: 20, l: 28 } as const

/** Font size in px for a text node's `size` (default `m`). */
export const fontSizePx = (size?: 's' | 'm' | 'l'): number => FONT_PX[size ?? 'm']

/** Rough rendered width/height of a single-line label at a given font size. */
export function textExtent(text: string, fontPx = 20): { w: number; h: number } {
  const lines = text.split('\n')
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0)
  const scale = fontPx / 20
  return { w: Math.max(20, Math.round(longest * SIZE.charW * scale)), h: Math.round(lines.length * SIZE.lineH * scale) }
}
