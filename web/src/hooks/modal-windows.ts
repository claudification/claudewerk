/**
 * The detached-modal window registry.
 *
 * A live `Window` is not serializable, so it can never live on a ModalRecord
 * (which is meant to become persistable). It lives here, keyed by modal id, and
 * `getDetachedWindow()` reads it on the render that the presentation flip
 * triggers.
 */

const detachedWindows = new Map<string, Window>()

const DETACH_FEATURES = 'popup=yes,width=900,height=640'

/** The popup window hosting a detached modal, or undefined when not detached. */
export function getDetachedWindow(id: string): Window | undefined {
  return detachedWindows.get(id)
}

/**
 * Open the popup for a modal. MUST be called synchronously inside the click
 * gesture that asked for it, or popup blockers refuse. Returns false when
 * blocked, so the caller can stay where it was.
 */
export function openDetachedWindow(id: string): boolean {
  const win = window.open('', id, DETACH_FEATURES)
  if (!win) return false
  try {
    win.focus()
  } catch {}
  detachedWindows.set(id, win)
  return true
}

/** Close the popup we opened, if it is still ours to close. */
export function closeDetachedWindow(id: string): void {
  const win = detachedWindows.get(id)
  if (!win) return
  try {
    if (!win.closed) win.close()
  } catch {}
  detachedWindows.delete(id)
}

/** The popup closed itself (its own chrome) -- forget it without touching it. */
export function forgetDetachedWindow(id: string): void {
  detachedWindows.delete(id)
}
