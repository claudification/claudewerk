/**
 * Orthogonal connector geometry between two placed boxes. The route leaves and enters on
 * the sides the boxes actually face: side-by-side boxes connect right-edge -> left-edge,
 * stacked boxes bottom -> top (and top -> bottom when the target sits above), with a mid
 * elbow when the two are not aligned on the crossing axis.
 *
 * Routing on the dominant axis is what keeps a connector OUTSIDE both boxes: the old fixed
 * bottom -> top route sent every lane-to-lane arrow on a detour under the row, which read as
 * a line crossing the diagram (2026-08-05).
 *
 * Shared by the Excalidraw edge router (which makes the points relative) and the SVG
 * renderer (which uses them absolute), so the routing lives in exactly one place. Pure.
 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Connector {
  /** Absolute polyline points, from an edge of `from` to the facing edge of `to`. */
  points: number[][]
  /** Visual mid-point of the route (where an on-line label/pill sits). */
  mid: [number, number]
}

/** Below this much offset on the crossing axis the route is a straight line, not an elbow. */
const ALIGNED_EPS = 4

interface Axis {
  /** Where the connector leaves `from` and arrives at `to`, along the routing axis. */
  start: number
  end: number
  /** The two box centres on the crossing axis (the elbow steps between them). */
  fromCross: number
  toCross: number
}

/** Leave/arrive on the FACING edges: `to` beyond `from` -> from's far edge to to's near edge,
 *  otherwise the mirror. */
function facingEdges(fromNear: number, fromFar: number, toNear: number, toFar: number): [number, number] {
  return toNear >= fromFar ? [fromFar, toNear] : [fromNear, toFar]
}

function horizontalAxis(from: Rect, to: Rect): Axis {
  const [start, end] = facingEdges(from.x, from.x + from.w, to.x, to.x + to.w)
  return { start, end, fromCross: from.y + from.h / 2, toCross: to.y + to.h / 2 }
}

function verticalAxis(from: Rect, to: Rect): Axis {
  const [start, end] = facingEdges(from.y, from.y + from.h, to.y, to.y + to.h)
  return { start, end, fromCross: from.x + from.w / 2, toCross: to.x + to.w / 2 }
}

/** The polyline for an axis as (along, across) pairs: straight when the boxes line up on the
 *  crossing axis, otherwise out -> across at the halfway point -> in. */
function route({ start, end, fromCross, toCross }: Axis): number[][] {
  if (Math.abs(toCross - fromCross) < ALIGNED_EPS) {
    return [
      [start, fromCross],
      [end, fromCross],
    ]
  }
  const bend = start + (end - start) / 2
  return [
    [start, fromCross],
    [bend, fromCross],
    [bend, toCross],
    [end, toCross],
  ]
}

export function orthogonalConnector(from: Rect, to: Rect): Connector {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  const horizontal = Math.abs(dx) > Math.abs(dy)
  const axis = horizontal ? horizontalAxis(from, to) : verticalAxis(from, to)
  const along = route(axis)
  // The axis math is written along-first; a vertical route is the same polyline transposed.
  const points = horizontal ? along : along.map(([along1, across]) => [across, along1])
  const alongMid = (axis.start + axis.end) / 2
  const acrossMid = (axis.fromCross + axis.toCross) / 2
  return { points, mid: horizontal ? [alongMid, acrossMid] : [acrossMid, alongMid] }
}
