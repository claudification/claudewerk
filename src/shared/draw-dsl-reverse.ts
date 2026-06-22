/**
 * Reverse pass (canvas -> agent, on submit): the edited Excalidraw scene -> a compact
 * current-state `Scene` + a `SceneDiff`. Runs on the serialized scene's elements (which
 * carry `customData.dslId` from the expander post-pass), so it needs no Excalidraw
 * runtime -- pure and bun-testable.
 *
 *   - Group agent elements by `customData.dslId`; rebuild each as a free-positioned node.
 *   - Diff vs the seeded scene's baseline (re-derived via the pure layout half of the
 *     expander): moved / resized / relabeled / removed.
 *   - `added` = live elements with NO dslId = the annotation layer (absence IS the signal).
 */
import { type Annotation, type DslNode, isContainer, type NodeChange, type Scene, type SceneDiff } from './draw-dsl'
import { expandScene } from './draw-dsl-expand'

/** Minimal structural view of an Excalidraw element as read back from the scene. */
export interface RawElement {
  id: string
  type: string
  x?: number
  y?: number
  width?: number
  height?: number
  text?: string
  isDeleted?: boolean
  containerId?: string | null
  frameId?: string | null
  customData?: { dslId?: string; role?: string; data?: object } | null
}

interface Box {
  x: number
  y: number
  w: number
  h: number
  text?: string
  data?: object
  frame?: string
}

const EDGE = '~edge~'
const eps = (a = 0, b = 0): boolean => Math.abs(a - b) > 1

export function reverseScene(elements: RawElement[], base: Scene): { scene: Scene; diff: SceneDiff } {
  const baseline = baselineBoxes(base)
  const tpl = flattenNodes(base)
  const live = elements.filter(e => !e.isDeleted)
  const { groups, annotations } = partition(live)
  const { nodes, moved, resized, relabeled } = diffGroups(groups, baseline, tpl)

  const removed = [...baseline.keys()].filter(id => !id.includes(EDGE) && !groups.has(id))
  const surviving = new Set(nodes.map(n => ('id' in n ? n.id : undefined)))
  const edges = (base.edges ?? []).filter(e => surviving.has(e.from) && surviving.has(e.to))
  const diff: SceneDiff = { added: annotations, removed, moved, resized, relabeled }
  return { scene: { v: 1, layout: 'free', nodes, edges }, diff }
}

/** Split live elements into agent groups (by dslId) and the annotation layer (no dslId). */
function partition(live: RawElement[]): { groups: Map<string, RawElement[]>; annotations: Annotation[] } {
  const groups = new Map<string, RawElement[]>()
  const annotations: Annotation[] = []
  const agentIds = new Set(live.map(e => e.customData?.dslId).filter((d): d is string => !!d))
  for (const e of live) {
    const dslId = e.customData?.dslId
    if (dslId) {
      const g = groups.get(dslId) ?? []
      g.push(e)
      groups.set(dslId, g)
    } else if (!(e.containerId && agentIds.has(boundOwner(e, live)))) {
      annotations.push(annotationOf(e))
    }
  }
  return { groups, annotations }
}

interface Changes {
  nodes: DslNode[]
  moved: NodeChange[]
  resized: NodeChange[]
  relabeled: NodeChange[]
}

/** Per-group: reconstruct the current node + collect its move/resize/relabel vs baseline. */
function diffGroups(groups: Map<string, RawElement[]>, baseline: Map<string, Box>, tpl: Map<string, DslNode>): Changes {
  const acc: Changes = { nodes: [], moved: [], resized: [], relabeled: [] }
  for (const [dslId, els] of groups) {
    if (dslId.includes(EDGE)) continue
    const cur = boxOf(dslId, els)
    const b = baseline.get(dslId)
    if (b) collectChange(dslId, cur, b, acc)
    acc.nodes.push(reconstruct(dslId, cur, tpl.get(dslId)))
  }
  return acc
}

function collectChange(dslId: string, cur: Box, b: Box, acc: Changes): void {
  if (eps(cur.x, b.x) || eps(cur.y, b.y)) acc.moved.push({ dslId, at: [r(cur.x), r(cur.y)], frame: cur.frame })
  if (eps(cur.w, b.w) || eps(cur.h, b.h)) acc.resized.push({ dslId, w: r(cur.w), h: r(cur.h) })
  if (cur.text !== undefined && cur.text !== b.text) acc.relabeled.push({ dslId, text: cur.text })
}

/** Baseline bbox/label per dslId, from the pure layout half of the expander. */
function baselineBoxes(base: Scene): Map<string, Box> {
  const { skeletons, metaById } = expandScene(base)
  const out = new Map<string, Box>()
  for (const sk of skeletons) {
    const dslId = primaryDslId(sk, metaById)
    if (dslId)
      out.set(dslId, {
        x: sk.x ?? 0,
        y: sk.y ?? 0,
        w: sk.width ?? 0,
        h: sk.height ?? 0,
        text: sk.label?.text ?? sk.text,
      })
  }
  return out
}

/** dslId of a skeleton that is a node's PRIMARY shape (id === dslId); else null (arrows, macro sub-shapes). */
function primaryDslId(sk: { id?: string }, metaById: Record<string, { dslId: string }>): string | null {
  const dslId = sk.id ? metaById[sk.id]?.dslId : undefined
  if (!dslId || sk.id !== dslId || dslId.includes(EDGE)) return null
  return dslId
}

/** Current bbox/label/data of a dslId group. A single-shape macro keys off its primary
 * (id===dslId); a multi-shape group with none (a mermaid subgraph) uses the union box. */
function boxOf(dslId: string, els: RawElement[]): Box {
  const exact = els.find(e => e.id === dslId)
  const data = els.find(e => e.customData?.data)?.customData?.data
  return { ...(exact ? xywh(exact) : unionBox(els)), text: labelText(els), data, frame: frameOf(exact ?? els[0]) }
}

const xywh = (e: RawElement) => ({ x: e.x ?? 0, y: e.y ?? 0, w: e.width ?? 0, h: e.height ?? 0 })
const frameOf = (e?: RawElement): string | undefined => e?.frameId ?? undefined

/** Smallest box enclosing every element in the group (used for mermaid subgraphs). */
function unionBox(els: RawElement[]): { x: number; y: number; w: number; h: number } {
  if (!els.length) return { x: 0, y: 0, w: 0, h: 0 }
  const x = Math.min(...els.map(e => e.x ?? 0))
  const y = Math.min(...els.map(e => e.y ?? 0))
  const w = Math.max(...els.map(e => (e.x ?? 0) + (e.width ?? 0))) - x
  const h = Math.max(...els.map(e => (e.y ?? 0) + (e.height ?? 0))) - y
  return { x, y, w, h }
}

/** Prefer the bound text (a shape's label) over a free text element. */
const labelText = (els: RawElement[]): string | undefined =>
  (els.find(e => e.type === 'text' && e.containerId) ?? els.find(e => e.type === 'text'))?.text

/** Rebuild a node from its template (kind/data preserved) at its current free position. */
function reconstruct(dslId: string, cur: Box, template?: DslNode): DslNode {
  if (template) {
    const base: Record<string, unknown> = { ...template, at: [r(cur.x), r(cur.y)] }
    if (isContainer(template.kind)) base.children = []
    else {
      base.w = r(cur.w)
      base.h = r(cur.h)
    }
    if (cur.text !== undefined && 'text' in template) base.text = cur.text
    if (cur.data !== undefined) base.data = cur.data
    return base as unknown as DslNode
  }
  return { id: dslId, kind: 'box', text: cur.text, at: [r(cur.x), r(cur.y)], w: r(cur.w), h: r(cur.h) }
}

function flattenNodes(scene: Scene): Map<string, DslNode> {
  const map = new Map<string, DslNode>()
  const visit = (ns: DslNode[]): void => {
    for (const n of ns) {
      if ('id' in n && n.id) map.set(n.id, n)
      if ('children' in n && Array.isArray(n.children)) visit(n.children)
    }
  }
  visit(scene.nodes)
  return map
}

function annotationOf(e: RawElement): Annotation {
  const role = e.customData?.role
  return {
    id: e.id,
    type: e.type,
    x: r(e.x ?? 0),
    y: r(e.y ?? 0),
    w: r(e.width ?? 0),
    h: r(e.height ?? 0),
    text: e.text,
    ...(role ? { role } : {}),
  }
}

/** The dslId of a bound text's container, if the container is an agent element. */
function boundOwner(e: RawElement, live: RawElement[]): string {
  const owner = live.find(o => o.id === e.containerId)
  return owner?.customData?.dslId ?? ''
}

const r = (n: number): number => Math.round(n)
