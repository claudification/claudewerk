/**
 * Edge -> connector skeletons: the routed arrow/line plus, when the edge has text, a white
 * "pill" chip centered on the line (clean Nunito, the polished on-line label from the
 * reference). Split out of draw-dsl-skeleton.ts to keep that file under the size bar. Pure.
 *
 * convert does NOT route bound arrows on its own (their points stay a stub), so we compute
 * explicit orthogonal geometry from the already-placed box skeletons; the start/end bindings
 * still make the arrow follow a box dragged in the live editor.
 */
import type { Edge, Skeleton } from './draw-dsl'
import { FONT_FAMILY } from './scheme-variants'

interface Path {
  x: number
  y: number
  points: number[][]
}

/** An edge -> the connector arrow + (when it has text) a pill chip on its mid-point. The
 * pill is a free chip, NOT the arrow's bound label (which renders in the sketch font, no
 * border). Caller maps every returned id to the edge's dslId for the round-trip. */
export function edgeSkeletons(e: Edge, placed: Skeleton[], id: string): Skeleton[] {
  const line = e.arrow === '--'
  const path = edgePath(placed, e.from, e.to)
  const arrow: Skeleton = {
    type: line ? 'line' : 'arrow',
    id,
    x: path?.x ?? 0,
    y: path?.y ?? 0,
    ...(path ? { points: path.points } : {}),
    start: { id: e.from },
    end: { id: e.to },
    strokeStyle: e.dashed ? 'dashed' : 'solid',
    ...(line ? {} : { endArrowhead: 'arrow', startArrowhead: e.arrow === '<->' ? 'arrow' : null }),
  }
  if (!e.text || !path) return [arrow]
  return [arrow, ...pillChip(id, path, e.text)]
}

/** A placed box's centre-x, top and bottom edges -- or null if it has no resolved geometry. */
function boxEdges(sks: Skeleton[], id: string): { cx: number; top: number; bottom: number } | null {
  const s = sks.find(x => x.id === id)
  if (!s || s.x == null || s.y == null) return null
  return { cx: s.x + (s.width ?? 0) / 2, top: s.y, bottom: s.y + (s.height ?? 0) }
}

/** Explicit orthogonal geometry between two placed boxes (bottom-centre -> top-centre, with a
 * mid elbow when not vertically aligned). */
function edgePath(sks: Skeleton[], fromId: string, toId: string): Path | null {
  const f = boxEdges(sks, fromId)
  const t = boxEdges(sks, toId)
  if (!f || !t) return null
  const dx = t.cx - f.cx
  const dy = t.top - f.bottom
  const points =
    Math.abs(dx) < 4
      ? [
          [0, 0],
          [0, dy],
        ]
      : [
          [0, 0],
          [0, dy / 2],
          [dx, dy / 2],
          [dx, dy],
        ]
  return { x: f.cx, y: f.bottom, points }
}

/** A white rounded chip + centered Nunito label on the connector mid-point. For both the
 * straight and the down-across-down elbow path the visual midpoint is half the total delta
 * (the elbow's horizontal run sits at dy/2). */
function pillChip(edgeId: string, path: Path, text: string): Skeleton[] {
  const last = path.points[path.points.length - 1]
  const cx = path.x + last[0] / 2
  const cy = path.y + last[1] / 2
  const w = Math.max(64, text.length * 13 * 0.62 + 22)
  const h = 26
  return [
    {
      type: 'rectangle',
      id: `${edgeId}~pill`,
      x: cx - w / 2,
      y: cy - h / 2,
      width: w,
      height: h,
      backgroundColor: '#ffffff',
      strokeColor: '#ced4da',
      fillStyle: 'solid',
      roughness: 1,
      roundness: { type: 3 },
    },
    {
      type: 'text',
      id: `${edgeId}~pilltext`,
      x: cx,
      y: cy - 13 * 0.6,
      text,
      fontSize: 13,
      strokeColor: '#343a40',
      fontFamily: FONT_FAMILY.nunito,
      textAlign: 'center',
    },
  ]
}
