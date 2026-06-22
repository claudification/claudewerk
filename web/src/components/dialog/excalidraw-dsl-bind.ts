/**
 * The Excalidraw-binding half of the expander (web-only; needs the Excalidraw runtime).
 * The pure half (DSL `Scene` -> skeletons + `customData` meta + mermaid placements) lives
 * in `@shared/draw-dsl-expand`; here we run `convertToExcalidrawElements({regenerateIds:
 * false})` so our DSL ids survive, then the post-pass stamps `customData` (the skeleton
 * type can't carry it). Bound text inherits its container's dslId via `containerId`.
 *
 * Mermaid nodes are parsed asynchronously via `@excalidraw/mermaid-to-excalidraw` (a heavy
 * dep -- dynamic-imported ONLY when a scene actually carries a mermaid node, LAZY LOAD
 * covenant) and translated under the box the layout reserved; every produced element is
 * stamped with the mermaid node's dslId so the reverse pass treats the whole subgraph as
 * one agent node (def preserved) and the user's annotations stay distinct.
 *
 * Lives in the lazy Excalidraw chunk (imported by excalidraw-canvas.tsx).
 */
import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { NodeMeta, Scene } from '@shared/draw-dsl'
import { expandScene } from '@shared/draw-dsl-expand'
import type { MermaidPlacement } from '@shared/draw-dsl-skeleton'

type Element = ReturnType<typeof convertToExcalidrawElements>[number]

/** Expand a DSL Scene to Excalidraw elements tagged with `customData.dslId` (async: a
 * scene with mermaid nodes parses them through the lazy mermaid runtime). */
export async function dslToElements(scene: Scene): Promise<Element[]> {
  const { skeletons, metaById, mermaids } = expandScene(scene)
  const base = convertToExcalidrawElements(skeletons as never, { regenerateIds: false }).map(el => stamp(el, metaById))
  if (!mermaids.length) return base
  return [...base, ...(await expandMermaids(mermaids))]
}

/** Stamp `customData.dslId` from the meta map (direct id, or the bound container's id). */
function stamp(el: Element, metaById: Record<string, NodeMeta>): Element {
  const containerId = (el as { containerId?: string | null }).containerId
  const meta = metaById[el.id] ?? (containerId ? metaById[containerId] : undefined)
  if (!meta) return el
  return { ...el, customData: { dslId: meta.dslId, role: meta.role, data: meta.data } }
}

/** Parse each mermaid node, translate its subgraph under the reserved box, stamp dslId. */
async function expandMermaids(mermaids: MermaidPlacement[]): Promise<Element[]> {
  const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw')
  const out: Element[] = []
  for (const m of mermaids) {
    try {
      const { elements: skeletons } = await parseMermaidToExcalidraw(m.def)
      const els = translate(convertToExcalidrawElements(skeletons as never), m.x, m.y)
      for (const el of els) out.push(withMermaidMeta(el, m))
    } catch (err) {
      out.push(...mermaidError(m, err))
    }
  }
  return out
}

/** Shift a freshly-laid subgraph so its top-left sits at the reserved (x, y). */
function translate(els: Element[], x: number, y: number): Element[] {
  if (!els.length) return els
  const dx = x - Math.min(...els.map(e => e.x))
  const dy = y - Math.min(...els.map(e => e.y))
  return els.map(el => ({ ...el, x: el.x + dx, y: el.y + dy }))
}

const withMermaidMeta = (el: Element, m: MermaidPlacement): Element => ({
  ...el,
  customData: { dslId: m.id, role: 'agent', data: { ...m.data, mermaid: true } },
})

/** A bad mermaid def renders a dashed error box (still tagged with the node's dslId so the
 * round-trip holds and the agent sees what failed) instead of silently vanishing. */
function mermaidError(m: MermaidPlacement, err: unknown): Element[] {
  const msg = err instanceof Error ? err.message : String(err)
  const box = convertToExcalidrawElements([
    {
      type: 'rectangle',
      x: m.x,
      y: m.y,
      width: m.w,
      height: m.h,
      strokeColor: '#e03131',
      strokeStyle: 'dashed',
      label: { text: `mermaid error: ${msg.slice(0, 120)}` },
    },
  ] as never)
  return box.map(el => ({
    ...el,
    customData: { dslId: m.id, role: 'agent', data: { ...m.data, mermaid: true, error: true } },
  }))
}
