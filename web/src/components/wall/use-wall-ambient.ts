/**
 * W3 AMBIENT -- the wall goes fullscreen, drops its chrome and grows its type
 * until it reads from across the room.
 *
 * Two things do the work, and only one of them is CSS:
 *
 * 1. The FULLSCREEN API, on the wall root. That is what removes the managed
 *    surface's own title bar: the bar is a SIBLING above the body slot, so no
 *    class the body can set will hide it -- but a fullscreen element paints
 *    alone, and everything outside it stops existing. Free, and correct in the
 *    detached window too, where the root lives in the popup's document.
 * 2. A `data-ambient` attribute for the type scale and the panes that opt out.
 *
 * The key handler binds to the ROOT'S OWN DOCUMENT, not `window`: detached, the
 * wall is portaled into a second document whose events never reach the opener.
 * It listens in the CAPTURE phase and stops Escape there so Radix's dismissable
 * layer (a bubble-phase document listener) never sees it -- otherwise leaving
 * ambient would also close the whole surface.
 */

import { type RefObject, useEffect } from 'react'
import { useWallStore } from './wall-state'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** Fullscreen is unavailable in jsdom and refused outside a user gesture. Both
 *  are fine: the attribute still flips, so the wall still scales and hides its
 *  chrome -- it just shares the screen. */
function requestFullscreen(el: HTMLElement): void {
  void el.requestFullscreen?.().catch(() => {})
}

function exitFullscreen(doc: Document): void {
  if (doc.fullscreenElement) void doc.exitFullscreen?.().catch(() => {})
}

export function useWallAmbient(rootRef: RefObject<HTMLElement | null>, visible: boolean): boolean {
  const ambient = useWallStore(s => s.ambient)

  // Keys. Re-bound whenever the wall changes document (inline <-> detached).
  useEffect(() => {
    const root = rootRef.current
    if (!visible || !root) return
    const doc = root.ownerDocument

    function onKeyDown(event: KeyboardEvent) {
      const store = useWallStore.getState()
      if (event.key === 'Escape' && store.ambient) {
        // Stop here, in capture, or Radix dismisses the surface underneath us.
        event.preventDefault()
        event.stopPropagation()
        store.setAmbient(false)
        return
      }
      if (event.key !== 'a' && event.key !== 'A') return
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return
      event.preventDefault()
      store.toggleAmbient()
    }

    doc.addEventListener('keydown', onKeyDown, true)
    return () => doc.removeEventListener('keydown', onKeyDown, true)
  }, [rootRef, visible])

  // Drive the fullscreen request off the flag, so the button and the `A` key and
  // a programmatic toggle all behave identically.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (ambient && visible) requestFullscreen(root)
    else exitFullscreen(root.ownerDocument)
  }, [ambient, visible, rootRef])

  // Leaving fullscreen by the browser's own gesture (F11, the Esc the browser
  // swallows) has to land back on the flag, or the wall stays scaled up inside a
  // window it no longer owns.
  useEffect(() => {
    const root = rootRef.current
    if (!visible || !root) return
    const doc = root.ownerDocument
    function onChange() {
      if (!doc.fullscreenElement) useWallStore.getState().setAmbient(false)
    }
    doc.addEventListener('fullscreenchange', onChange)
    return () => doc.removeEventListener('fullscreenchange', onChange)
  }, [rootRef, visible])

  // Parking the wall must not leave the browser stuck in fullscreen.
  useEffect(() => {
    if (visible) return
    useWallStore.getState().setAmbient(false)
  }, [visible])

  return ambient
}
