/**
 * OKLCH -> sRGB -> WCAG contrast.
 *
 * Every colour in this app is authored in OKLCH, and OKLCH lightness is not
 * WCAG luminance -- two tokens can look a step apart and still fail a text
 * contrast check, or vice versa. Guessing at that boundary is what produced
 * 628 illegible `text-muted-foreground/40` sites.
 *
 * `theme-ladder.ts` owns ΔL, which is the right metric for SURFACE-vs-SURFACE
 * at the dark end (contrast ratio compresses there until a visible step and an
 * invisible one both read ~1.1:1). This owns TEXT-on-surface, where WCAG is the
 * right metric. Use the one that matches the question.
 */

import type { Oklch } from './theme-ladder'

export type Rgb = [number, number, number]

/** OKLCH -> sRGB, clamped into gamut. Components are 0..1. */
export function oklchToSrgb({ l: L, c: C, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180
  const a = C * Math.cos(rad)
  const b = C * Math.sin(rad)
  const lc = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mc = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sc = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const encode = (x: number) => {
    const v = Math.min(1, Math.max(0, x))
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
  }
  return [
    encode(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    encode(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    encode(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc),
  ]
}

function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `color-mix(in oklch, fg alpha%, transparent)` painted over `bg`. */
export function composite(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [fg[0] * alpha + bg[0] * (1 - alpha), fg[1] * alpha + bg[1] * (1 - alpha), fg[2] * alpha + bg[2] * (1 - alpha)]
}

export const AA_BODY = 4.5
