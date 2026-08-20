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

/**
 * THE OPENER'S LIFE IS THE POPUP'S LIFE.
 *
 * A detached surface is not a second app. Its React subtree, its store, its
 * WebSocket and its whole reason for existing live in the OPENER's tab (see
 * popout-window.tsx) -- so when the opener reloads, every popup still on screen
 * becomes a corpse: pixels of a tree that no longer has a program behind it.
 * Nothing updates, nothing responds, and the reloaded tab has no handle to any
 * of them, so it cannot even offer to clean them up. Reported 2026-08-20: "when
 * I do clear/reload on main window, they stay open - which is impossible".
 *
 * `pagehide` rather than `beforeunload`: it fires on reload, navigation and tab
 * close, and it does not suppress the back/forward cache.
 *
 * `persisted` is the exception that matters. A bfcache freeze is not a death --
 * the tab can come back with its heap intact, and the popups would still be
 * wired to it. Killing them there would break the working case to tidy up after
 * the broken one.
 */
function closeAllDetachedWindows(): void {
  for (const id of [...detachedWindows.keys()]) closeDetachedWindow(id)
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', event => {
    if (!event.persisted) closeAllDetachedWindows()
  })
}
