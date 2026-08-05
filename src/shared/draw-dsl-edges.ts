/**
 * Edge -> connector skeletons: the routed arrow/line, carrying the edge's text as the arrow's
 * BOUND label. Split out of draw-dsl-skeleton.ts to keep that file under the size bar. Pure.
 *
 * convert does NOT route arrows on its own (their points stay a stub), so we compute explicit
 * orthogonal geometry from the already-placed box skeletons.
 *
 * Two different bindings live here, do not conflate them:
 *   - ELEMENT binding (start/end -> box ids) is a FALLBACK ONLY, for an edge we could not
 *     place. Excalidraw re-anchors a bound arrow to both elements' CENTRES, which discards
 *     our elbow and draws the connector straight through the boxes it joins.
 *   - LABEL binding (`label`) is always on when the edge has text: Excalidraw gives the label
 *     a containerId plus an entry in the arrow's boundElements, so it rides the connector and
 *     the stroke breaks around it -- what you get drawing one by hand. The free
 *     rectangle+text chip this used to emit stayed where it was first laid out the moment
 *     anyone dragged a box: a white box stranded on top of the connector.
 */

import { orthogonalConnector, type Rect } from './diagram-geometry'
import type { Edge, Skeleton } from './draw-dsl'
import { SCHEME_RECIPE } from './scheme-variants'

interface Path {
  x: number
  y: number
  points: number[][]
}

/** An edge -> one connector arrow (or line), labelled in place when the edge carries text. */
export function edgeSkeletons(e: Edge, placed: Skeleton[], id: string): Skeleton[] {
  const line = e.arrow === '--'
  const path = edgePath(placed, e.from, e.to)
  const R = SCHEME_RECIPE
  return [
    {
      type: line ? 'line' : 'arrow',
      id,
      x: path?.x ?? 0,
      y: path?.y ?? 0,
      // Our own routing when we have geometry; the id bindings ONLY as the fallback for an
      // edge we could not place. Mutually exclusive on purpose -- see the header note on the
      // centre re-anchor (the arrows-through-boxes render, 2026-08-05).
      ...(path ? { points: path.points } : { start: { id: e.from }, end: { id: e.to } }),
      strokeStyle: e.dashed ? 'dashed' : 'solid',
      ...(line ? {} : { endArrowhead: 'arrow', startArrowhead: e.arrow === '<->' ? 'arrow' : null }),
      ...(e.text
        ? { label: { text: e.text, fontSize: R.edgePx, fontFamily: R.edgeFont, strokeColor: R.edgeColor } }
        : {}),
    },
  ]
}

/** A placed box's rect, or null if it has no resolved geometry. */
function rectOf(sks: Skeleton[], id: string): Rect | null {
  const s = sks.find(x => x.id === id)
  if (!s || s.x == null || s.y == null) return null
  return { x: s.x, y: s.y, w: s.width ?? 0, h: s.height ?? 0 }
}

/** Explicit orthogonal geometry between two placed boxes, made relative to the arrow's start
 * (Excalidraw arrow points are origin-relative). Shares the routing with the SVG renderer. */
function edgePath(sks: Skeleton[], fromId: string, toId: string): Path | null {
  const f = rectOf(sks, fromId)
  const t = rectOf(sks, toId)
  if (!f || !t) return null
  const { points } = orthogonalConnector(f, t)
  const [ox, oy] = points[0]
  return { x: ox, y: oy, points: points.map(([px, py]) => [px - ox, py - oy]) }
}
