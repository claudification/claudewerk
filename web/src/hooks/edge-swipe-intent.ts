/**
 * Edge-swipe decision, extracted as a pure function so the gesture thresholds
 * are testable without synthesising TouchEvents.
 *
 * WHY EDGES AND NOT THE MIDDLE: on iOS the bottom edge is the home indicator
 * and the top edge is Control Centre, so neither is available to a web app.
 * That leaves the two side edges.
 *
 * THE KNOWN COLLISION: Safari uses a left-edge drag for BACK and a right-edge
 * drag for FORWARD. We already ship the left one (it opens the sidebar) and it
 * works in practice, so the right is the same trade rather than a new risk. The
 * start zone is deliberately a little inboard of the extreme edge, which is what
 * keeps the system gesture from winning most of the time.
 */

/** How far in from an edge a touch may start and still count as an edge swipe. */
const EDGE_ZONE_PX = 40
/** Minimum horizontal travel before it is a swipe rather than a tap or a scroll. */
const MIN_TRAVEL_PX = 60
/** Vertical drift is allowed up to this fraction of the horizontal travel. */
const MAX_DRIFT_RATIO = 0.5
/** Slower than this and it is a drag, not a flick — let it go. */
const MAX_DURATION_MS = 500

export interface SwipeStart {
  x: number
  y: number
  t: number
}

export interface SwipeEnd {
  x: number
  y: number
  t: number
}

/** Which edge a touch began at, or null if it began in open canvas. */
export function edgeOf(x: number, viewportWidth: number): 'left' | 'right' | null {
  if (x <= EDGE_ZONE_PX) return 'left'
  if (x >= viewportWidth - EDGE_ZONE_PX) return 'right'
  return null
}

/**
 * The completed gesture, or null.
 *
 * `left` means "started at the left edge and travelled right" — the direction
 * that pulls a panel in from that side. `right` is its mirror.
 */
export function edgeSwipeIntent(start: SwipeStart, end: SwipeEnd, viewportWidth: number): 'left' | 'right' | null {
  const edge = edgeOf(start.x, viewportWidth)
  if (!edge) return null

  const dx = end.x - start.x
  const drift = Math.abs(end.y - start.y)
  const elapsed = end.t - start.t

  if (elapsed > MAX_DURATION_MS) return null

  const travel = Math.abs(dx)
  if (travel < MIN_TRAVEL_PX) return null
  if (drift > travel * MAX_DRIFT_RATIO) return null

  // The swipe has to move AWAY from its edge, or it is a dismissal of something
  // else entirely.
  if (edge === 'left' && dx <= 0) return null
  if (edge === 'right' && dx >= 0) return null

  return edge
}
