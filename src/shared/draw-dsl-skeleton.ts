/**
 * DSL skeleton pass: positioned `Placed` nodes -> Excalidraw element skeletons (+ a
 * `customData` meta map keyed by skeleton id). Primitives map 1:1; semantic-UI nodes
 * (button/input/checkbox/nav/image) macro-expand to a small sketchy-wireframe group;
 * card/screen become frames; edges become id-bound arrows.
 *
 * Skeleton ids: a node's PRIMARY shape carries `node.id` (the dslId); macro-internal
 * extras use `${id}~suffix`; convert's auto-created bound text inherits the dslId via
 * its `containerId` in the post-pass. Pure -- the canvas feeds these to
 * `convertToExcalidrawElements({regenerateIds:false})`.
 */
import { type DslNode, type Edge, fontSizePx, type NodeMeta, type Placed, type Skeleton, type Style } from './draw-dsl'
import { edgeSkeletons } from './draw-dsl-edges'
import { uiMacro } from './draw-dsl-macros'
import { schemeBox } from './draw-dsl-scheme-box'
import { FONT_FAMILY, isSchemeBox } from './scheme-variants'

export interface Expanded {
  skeletons: Skeleton[]
  metaById: Record<string, NodeMeta>
  /** Placed mermaid nodes -- expanded asynchronously in the web bind layer (the pure pass
   * can't run the mermaid runtime). Each carries the absolute box the agent reserved for it. */
  mermaids: MermaidPlacement[]
}

/** A `mermaid` DSL node positioned by the layout pass; the web layer parses `def` into it. */
export interface MermaidPlacement {
  id: string
  def: string
  x: number
  y: number
  w: number
  h: number
  data?: object
}

/** Walk the placed tree -> skeletons + meta; append edge arrows last (bind by id). */
export function buildSkeletons(placed: Placed[], edges: Edge[]): Expanded {
  const out: Expanded = { skeletons: [], metaById: {}, mermaids: [] }
  let auto = 0
  const idOf = (n: DslNode): string => ('id' in n && n.id ? n.id : `auto-${n.kind}-${auto++}`)
  for (const p of placed) walk(p, out, idOf)
  for (const e of edges) {
    const id = `${e.from}~edge~${e.to}`
    out.metaById[id] = { dslId: id, role: 'agent' }
    for (const sk of edgeSkeletons(e, out.skeletons, id)) {
      if (sk.id && sk.id !== id) out.metaById[sk.id] = { dslId: id, role: 'agent' }
      out.skeletons.push(sk)
    }
  }
  return out
}

/** Returns the element ids this subtree contributes to a parent frame's `children`. */
function walk(p: Placed, out: Expanded, idOf: (n: DslNode) => string): string[] {
  const node = p.node
  if (node.kind === 'row' || node.kind === 'col' || node.kind === 'grid') {
    return (p.children ?? []).flatMap(c => walk(c, out, idOf))
  }
  if (node.kind === 'mermaid') {
    // No sync skeleton: the web layer parses `def` and appends the subgraph at (x,y).
    out.mermaids.push({ id: node.id, def: node.def, x: p.x, y: p.y, w: p.w, h: p.h, data: node.data })
    return []
  }
  if (node.kind === 'card' || node.kind === 'screen') return [emitFrame(node, p, out, idOf)]
  return [emitLeaf(node, p, out, idOf)]
}

function emitFrame(
  node: Extract<DslNode, { kind: 'card' | 'screen' }>,
  p: Placed,
  out: Expanded,
  idOf: (n: DslNode) => string,
): string {
  const inner = (p.children ?? []).flatMap(c => walk(c, out, idOf))
  const id = node.id
  out.skeletons.push({
    type: 'frame',
    id,
    x: p.x,
    y: p.y,
    width: p.w,
    height: p.h,
    name: node.title ?? '',
    children: inner,
  })
  out.metaById[id] = { dslId: id, role: 'agent', data: node.data }
  return id
}

function emitLeaf(node: DslNode, p: Placed, out: Expanded, idOf: (n: DslNode) => string): string {
  const id = idOf(node)
  const sks = leafSkeletons(node, p, id)
  const data = 'data' in node ? node.data : undefined
  for (const sk of sks) if (sk.id) out.metaById[sk.id] = { dslId: id, role: 'agent', data }
  out.skeletons.push(...sks)
  return id
}

/** A generic shape skeleton (box/ellipse/diamond) sized to the placed bounds. */
function shape(type: Skeleton['type'], id: string, p: Placed, label?: string, style?: Style): Skeleton {
  return applyStyle(
    { type, id, x: p.x, y: p.y, width: p.w, height: p.h, ...(label ? { label: { text: label } } : {}) },
    style,
  )
}

function leafSkeletons(node: DslNode, p: Placed, id: string): Skeleton[] {
  switch (node.kind) {
    case 'box':
      return isSchemeBox(node) ? schemeBox(node, p, id) : [shape('rectangle', id, p, node.text, node.style)]
    case 'ellipse':
      return [shape('ellipse', id, p, node.text, node.style)]
    case 'diamond':
      return [shape('diamond', id, p, node.text, node.style)]
    case 'text':
      return [
        applyStyle({ type: 'text', id, x: p.x, y: p.y, text: node.text, fontSize: fontSizePx(node.size) }, node.style),
      ]
    default:
      return uiMacro(node, p, id)
  }
}

function applyStyle(sk: Skeleton, style?: Style): Skeleton {
  if (!style) return sk
  if (style.stroke) sk.strokeColor = style.stroke
  if (style.fill) sk.backgroundColor = style.fill
  if (style.fillStyle) sk.fillStyle = style.fillStyle
  if (style.rough !== undefined) sk.roughness = style.rough
  if (style.font) sk.fontFamily = FONT_FAMILY[style.font]
  return sk
}
