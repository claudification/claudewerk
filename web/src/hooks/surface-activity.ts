/**
 * The activity reducer -- how a surface's self-report becomes the record the
 * dock renders.
 *
 * Kept pure and out of the store so the two decisions that actually matter can
 * be tested directly:
 *
 * - WHEN IS IT UNREAD. A run that finishes while you are looking at it is not
 *   news; the same run finishing while it sits parked in the dock is the entire
 *   point of the feature. Only the manager knows which happened, so the surface
 *   never gets to decide.
 * - WHEN DOES THE TILE BLINK. On fresh output, not on every re-render. The
 *   surface hands over a `tick` that advances; we stamp the clock.
 */

import type { ModalPresentation, SurfaceActivity, SurfaceActivityInput, SurfaceStatus } from './modal-manager-types'

const FINISHED: Partial<Record<SurfaceStatus, true>> = { done: true, error: true }

/** True when nothing a viewer would notice has changed. */
export function sameActivity(prev: SurfaceActivity | undefined, next: SurfaceActivityInput): boolean {
  return (
    prev !== undefined &&
    prev.status === next.status &&
    prev.label === next.label &&
    prev.progress === next.progress &&
    prev.tick === next.tick
  )
}

/** Unread survives until someone looks; starting a fresh run clears it. */
function nextUnseen(
  prev: SurfaceActivity | undefined,
  next: SurfaceActivityInput,
  seen: boolean,
  ended: boolean,
): boolean {
  if (ended) return !seen
  if (next.status === 'running') return false
  return prev?.unseen ?? false
}

/** The finish clock: stamped on the flip, held afterwards, cleared on a restart. */
function nextFinishedAt(prev: SurfaceActivity | undefined, next: SurfaceActivityInput, ended: boolean, now: number) {
  if (ended) return now
  return FINISHED[next.status] ? prev?.finishedAt : undefined
}

export function nextActivity(
  prev: SurfaceActivity | undefined,
  next: SurfaceActivityInput,
  presentation: ModalPresentation,
  now: number,
): SurfaceActivity {
  const ended = Boolean(FINISHED[next.status]) && prev?.status !== next.status
  return {
    ...next,
    pulseAt: prev?.tick === next.tick ? prev?.pulseAt : now,
    finishedAt: nextFinishedAt(prev, next, ended, now),
    unseen: nextUnseen(prev, next, presentation === 'inline', ended),
  }
}
