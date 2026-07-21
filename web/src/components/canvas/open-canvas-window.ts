/**
 * Open a hosted canvas in its OWN browser window (the standalone /canvas/:id
 * route) -- the single opener shared by every call site.
 *
 * Why a real document load and NOT the portal popout: Excalidraw binds to the
 * GLOBAL `window` (`window.addEventListener('pointermove')`, `window.innerWidth`,
 * `handleKeyboardGlobally`). A createPortal popout puts the DOM in the popup but
 * leaves the React subtree -- and therefore that global -- in the PARENT tab, so
 * excalidraw registered drag listeners on the wrong window (shapes committed at
 * zero size) and laid itself out to the parent's viewport (chrome clipped off the
 * popup's right + bottom edges). Only a separate document gives it a `window`
 * that IS its window. The portal popout stays in use by ModalSurface, which is
 * pure React and has no such global coupling.
 *
 * Dedupe is the browser's: window.open() with a stable NAME reuses the existing
 * window for that canvas instead of stacking duplicates. We re-focus explicitly
 * because reusing a named window does not raise it on its own.
 */

const WINDOW_FEATURES = 'popup=yes,width=1100,height=760'

/** Stable per-canvas window name, so re-opening focuses instead of duplicating. */
function windowName(canvasId: string): string {
  return `canvas-${canvasId}`
}

/**
 * Open (or focus) the canvas window. Returns false when the browser blocked the
 * popup, so the caller can fall back to navigating the current tab.
 */
export function openCanvasWindow(canvasId: string): boolean {
  const url = `/canvas/${encodeURIComponent(canvasId)}`
  const win = window.open(url, windowName(canvasId), WINDOW_FEATURES)
  if (!win) return false
  // Cross-window focus() throws on a window the user closed mid-call -- ignore.
  try {
    win.focus()
  } catch {}
  return true
}
