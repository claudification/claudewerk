/**
 * Intrinsic sizing for the DSL layout pass: each node's width/height before placement
 * (containers measure their children). Pure; split out of draw-dsl-layout.ts so the
 * layout file stays small and the per-kind dispatch lives on its own.
 */
import { type DslNode, fontSizePx, type ShapeNode, SIZE, textExtent } from './draw-dsl'
import { isSchemeBox, SCHEME_RECIPE, schemeBlock } from './scheme-variants'

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
export const max = (xs: number[]): number => (xs.length ? Math.max(...xs) : 0)

const gapOf = (n: DslNode): number => ('gap' in n && typeof n.gap === 'number' ? n.gap : SIZE.gap)

/** Intrinsic width/height of a node. */
export function measure(node: DslNode): { w: number; h: number } {
  return isLeaf(node) ? measureLeaf(node) : measureContainer(node)
}

function isLeaf(node: DslNode): boolean {
  return (
    node.kind !== 'row' && node.kind !== 'col' && node.kind !== 'grid' && node.kind !== 'card' && node.kind !== 'screen'
  )
}

// A flat per-kind dispatch table (not branching logic) -- complexity is inherent.
// fallow-ignore-next-line complexity
function measureLeaf(node: DslNode): { w: number; h: number } {
  switch (node.kind) {
    case 'box':
    case 'ellipse':
    case 'diamond': {
      if (node.kind === 'box' && isSchemeBox(node)) return measureSchemeBox(node)
      const def = node.kind === 'box' ? SIZE.box : node.kind === 'ellipse' ? SIZE.ellipse : SIZE.diamond
      const t = node.text ? textExtent(node.text).w + SIZE.pad * 2 : 0
      return { w: Math.max(node.w ?? def[0], t), h: node.h ?? def[1] }
    }
    case 'text': {
      const e = textExtent(node.text, fontSizePx(node.size))
      return { w: e.w, h: e.h }
    }
    case 'button':
      return { w: Math.max(SIZE.button[0], textExtent(node.text).w + SIZE.pad * 2), h: SIZE.button[1] }
    case 'input':
      return { w: SIZE.inputField[0], h: (node.label ? SIZE.lineH : 0) + SIZE.inputField[1] + 4 }
    case 'checkbox':
      return { w: SIZE.checkbox + 8 + textExtent(node.text).w, h: SIZE.checkbox }
    case 'nav':
      return { w: node.items.reduce<number>((s, it) => s + textExtent(it).w + SIZE.pad, SIZE.pad), h: SIZE.nav }
    case 'mermaid':
      // The real subgraph is measured by parseMermaidToExcalidraw in the web layer; here
      // we reserve the agent's hint (or a default) so neighbours lay out around it.
      return { w: node.w ?? SIZE.mermaid[0], h: node.h ?? SIZE.mermaid[1] }
    default: // image
      return node.kind === 'image' ? { w: node.w ?? SIZE.image[0], h: node.h ?? SIZE.image[1] } : { w: 0, h: 0 }
  }
}

/** Generous box sized to its title/subtitle plus the recipe's breathing room. Uses the same
 * glyph estimate as the centering pass so text lands centered within the box, never spills. */
function measureSchemeBox(node: ShapeNode): { w: number; h: number } {
  const R = SCHEME_RECIPE
  const title = node.title ?? node.text ?? ''
  const sub = node.subtitle ?? ''
  const fit = (t: string, px: number): number => t.length * px * R.glyphW
  const widest = max([fit(title, R.titlePx), fit(sub, R.subPx)])
  return {
    w: node.w ?? Math.max(SIZE.box[0], Math.round(widest + R.padX * 2)),
    h: node.h ?? Math.round(schemeBlock(title, sub).blockH + R.padY * 2),
  }
}

function measureContainer(node: DslNode): { w: number; h: number } {
  if (node.kind === 'card' || node.kind === 'screen') {
    const inner = measureStack(node.children, gapOf(node))
    const h = node.kind === 'screen' ? node.h : undefined
    return { w: node.w ?? inner.w + SIZE.pad * 2, h: h ?? SIZE.titleBar + inner.h + SIZE.pad * 2 }
  }
  if (node.kind === 'row') {
    const ms = node.children.map(measure)
    return { w: sum(ms.map(m => m.w)) + gapOf(node) * Math.max(0, ms.length - 1), h: max(ms.map(m => m.h)) }
  }
  if (node.kind === 'col') return measureStack(node.children, gapOf(node))
  if (node.kind === 'grid') {
    const ms = node.children.map(measure)
    const cols = Math.max(1, node.cols)
    const rows = Math.ceil(ms.length / cols)
    const cw = max(ms.map(m => m.w))
    const ch = max(ms.map(m => m.h))
    return { w: cols * cw + gapOf(node) * (cols - 1), h: rows * ch + gapOf(node) * (rows - 1) }
  }
  return { w: 0, h: 0 }
}

function measureStack(children: DslNode[], gap: number): { w: number; h: number } {
  const ms = children.map(measure)
  return { w: max(ms.map(m => m.w)), h: sum(ms.map(m => m.h)) + gap * Math.max(0, ms.length - 1) }
}
