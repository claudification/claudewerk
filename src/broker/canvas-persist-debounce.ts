/**
 * The idle-persist debounce behind the canvas scene-write chokepoint.
 *
 * A room streams scene deltas far faster than they are worth writing, so the WS
 * path schedules a write 1.5s after the last one instead of hitting disk per
 * delta. Split out of canvas-room.ts so that file stays room membership + the
 * chokepoint; this owns exactly one thing: when a scene reaches disk.
 *
 * CANCELLATION IS THE LOAD-BEARING PART, not tidiness. A timer scheduled by an
 * earlier delta still holds the scene as it was THEN; if it fires after a newer
 * write it writes that stale scene back over it -- the same clobber the
 * chokepoint exists to kill, on a 1.5s fuse. Every write cancels first.
 */

import { saveCanvasScene } from './canvas-store'

export const PERSIST_DEBOUNCE_MS = 1500

/** canvasId -> pending persist. */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Drop any pending persist for a canvas. Callers do this on EVERY write,
 *  whichever way that write ends up persisting. */
export function cancelPendingPersist(canvasId: string): void {
  const pending = timers.get(canvasId)
  if (!pending) return
  clearTimeout(pending)
  timers.delete(canvasId)
}

/** Schedule the idle write. The caller has already cancelled whatever was
 *  pending (the chokepoint does it unconditionally), so this only arms. */
export function schedulePersist(canvasId: string, sceneJson: string): void {
  timers.set(
    canvasId,
    setTimeout(() => {
      timers.delete(canvasId)
      saveCanvasScene(canvasId, sceneJson)
    }, PERSIST_DEBOUNCE_MS),
  )
}

/** Test/lifecycle helper: drop every pending persist without firing it. */
export function cancelAllPendingPersists(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
}
