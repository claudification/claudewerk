/**
 * Colour palettes for the SVG diagram renderer -- the "nice display" lane (Excalidraw stays
 * the edit/multiplayer lane). Both themes are HAND-AUTHORED: the SVG renderer paints these
 * hexes directly, so dark mode is a real designed palette, not a filter inversion (which is
 * what muddied the Excalidraw path -- gold is gold here, not brown).
 *
 * Shared by `diagram-svg.ts` (any runtime) and, later, the transcript display block.
 */
import type { SchemeVariant } from './draw-dsl'

export type DiagramTheme = 'light' | 'dark'

export interface VariantColors {
  fill: string
  stroke: string
  title: string
  sub: string
}

export interface Palette {
  bg: string
  connector: string
  pill: { fill: string; stroke: string; text: string }
  variants: Record<SchemeVariant, VariantColors>
}

export const PALETTES: Record<DiagramTheme, Palette> = {
  light: {
    bg: '#ffffff',
    connector: '#2c4a72',
    pill: { fill: '#ffffff', stroke: '#c9d4e3', text: '#1f2a44' },
    variants: {
      blue: { fill: '#eef3fb', stroke: '#2c4a7e', title: '#1a2540', sub: '#6b7280' },
      gold: { fill: '#faf6ee', stroke: '#a07d3e', title: '#7a5d1f', sub: '#8a7240' },
      green: { fill: '#eefaf4', stroke: '#1f6f54', title: '#14533d', sub: '#3f6c5b' },
      rose: { fill: '#fbeef1', stroke: '#9a4759', title: '#7d2738', sub: '#9a6b74' },
      steel: { fill: '#f1f3f8', stroke: '#5b6b85', title: '#3a4762', sub: '#6b7280' },
      plain: { fill: '#fafbfc', stroke: '#c9d4e3', title: '#1f2a44', sub: '#6b7280' },
    },
  },
  dark: {
    bg: '#0d1017',
    connector: '#39517d',
    pill: { fill: '#11151f', stroke: '#33405b', text: '#cfe0ff' },
    variants: {
      blue: { fill: '#16213a', stroke: '#3a5a8c', title: '#cfe0ff', sub: '#8b94a7' },
      gold: { fill: '#241d12', stroke: '#c79a4e', title: '#e2bd76', sub: '#b89a63' },
      green: { fill: '#13241d', stroke: '#4caa82', title: '#7fd6ae', sub: '#6f9e8a' },
      rose: { fill: '#2a151b', stroke: '#c97d8c', title: '#f0b6c1', sub: '#b48b93' },
      steel: { fill: '#1a1f2b', stroke: '#6b7a96', title: '#c3cde0', sub: '#8b94a7' },
      plain: { fill: '#161b26', stroke: '#33405b', title: '#d6deec', sub: '#8b94a7' },
    },
  },
}
