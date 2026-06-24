/**
 * The "nice display" renderer: a compact diagram `Scene` -> a crisp, theme-aware SVG string.
 * Reuses the DSL layout pass (`placeScene`) for positioning and the shared connector geometry,
 * so it shares the auto-layout with the Excalidraw lane but renders publication-grade output:
 * real vector boxes, `text-anchor=middle` centering (no glyph estimate, ever), on-line pill
 * labels, and a HAND-AUTHORED dark palette (no filter inversion). Pure -- runs any runtime.
 */

import { orthogonalConnector, type Rect } from './diagram-geometry'
import { type DiagramTheme, PALETTES, type Palette } from './diagram-palette'
import type { Placed, Scene, SchemeVariant } from './draw-dsl'
import { placeScene } from './draw-dsl-layout'

const SANS = '-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Helvetica,Arial,sans-serif'
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
const PAD = 24

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const rect = (p: Placed): Rect => ({ x: p.x, y: p.y, w: p.w, h: p.h })

interface BoxNode {
  title?: string
  text?: string
  subtitle?: string
  variant?: SchemeVariant
}

/** Render a diagram Scene to a standalone SVG string in the given theme (default light). */
export function sceneToSvg(scene: Scene, theme: DiagramTheme = 'light'): string {
  const pal = PALETTES[theme]
  const placed = placeScene(scene)
  const byId = new Map<string, Placed>()
  for (const p of placed) if ('id' in p.node && p.node.id) byId.set(p.node.id, p)

  const w = Math.round(Math.max(0, ...placed.map(p => p.x + p.w)) + PAD * 2)
  const h = Math.round(Math.max(0, ...placed.map(p => p.y + p.h)) + PAD * 2)

  const body: string[] = []
  for (const e of scene.edges ?? []) {
    const f = byId.get(e.from)
    const t = byId.get(e.to)
    if (f && t) body.push(edgeSvg(f, t, e.text, pal))
  }
  for (const p of placed) body.push(boxSvg(p, pal))

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="${pal.bg}"/>` +
    `<g transform="translate(${PAD},${PAD})">${body.join('')}</g></svg>`
  )
}

function boxSvg(p: Placed, pal: Palette): string {
  const n = p.node as BoxNode
  const c = pal.variants[n.variant ?? 'plain']
  const cx = p.x + p.w / 2
  const cy = p.y + p.h / 2
  const title = n.title ?? n.text ?? ''
  const sub = n.subtitle
  const out = [
    `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="11" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>`,
  ]
  if (title) out.push(textSvg(cx, sub ? cy - 6 : cy + 6, title, 17, 700, c.title, SANS))
  if (sub) out.push(textSvg(cx, cy + 18, sub, 12, 400, c.sub, MONO))
  return out.join('')
}

function edgeSvg(f: Placed, t: Placed, label: string | undefined, pal: Palette): string {
  const { points, mid } = orthogonalConnector(rect(f), rect(t))
  const d = points.map((pt, i) => `${i ? 'L' : 'M'}${pt[0]} ${pt[1]}`).join(' ')
  const out = [`<path d="${d}" fill="none" stroke="${pal.connector}" stroke-width="1.5"/>`]
  if (label) {
    const pw = Math.round(label.length * 6.6 + 24)
    out.push(
      `<rect x="${mid[0] - pw / 2}" y="${mid[1] - 13}" width="${pw}" height="26" rx="13" fill="${pal.pill.fill}" stroke="${pal.pill.stroke}" stroke-width="1.2"/>`,
    )
    out.push(textSvg(mid[0], mid[1] + 4, label, 12.5, 600, pal.pill.text, SANS))
  }
  return out.join('')
}

function textSvg(x: number, y: number, s: string, size: number, weight: number, fill: string, font: string): string {
  return `<text x="${x}" y="${y}" text-anchor="middle" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(s)}</text>`
}
