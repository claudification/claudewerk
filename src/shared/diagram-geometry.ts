/**
 * Orthogonal connector geometry between two placed boxes -- the bottom-centre -> top-centre
 * route with a mid elbow when the boxes are not vertically aligned. Shared by the Excalidraw
 * edge router (which makes the points relative) and the SVG renderer (which uses them
 * absolute), so the routing lives in exactly one place. Pure.
 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Connector {
  /** Absolute polyline points, bottom-centre of `from` -> top-centre of `to`. */
  points: number[][]
  /** Visual mid-point of the route (where an on-line label/pill sits). */
  mid: [number, number]
}

export function orthogonalConnector(from: Rect, to: Rect): Connector {
  const fcx = from.x + from.w / 2
  const fb = from.y + from.h
  const tcx = to.x + to.w / 2
  const tt = to.y
  const dx = tcx - fcx
  const dy = tt - fb
  const points =
    Math.abs(dx) < 4
      ? [
          [fcx, fb],
          [fcx, tt],
        ]
      : [
          [fcx, fb],
          [fcx, fb + dy / 2],
          [tcx, fb + dy / 2],
          [tcx, tt],
        ]
  return { points, mid: [(fcx + tcx) / 2, fb + dy / 2] }
}
