/**
 * The SURFACE CANVAS -- one DOM node per managed surface, created once and MOVED
 * between hosts instead of being re-rendered into each of them.
 *
 * This is what makes the DETACHABLE SURFACES covenant true. Before it, the
 * surface body was rendered as `{children}` inside whichever host matched the
 * current presentation, so the body REMOUNTED on every flip: `docked` rendered
 * `<Dialog open={false}>` and Radix drops the whole DialogContent subtree, and
 * `detached` returned an entirely different tree. A parked Vacuum run therefore
 * came back re-measuring a database it had already measured.
 *
 * Now the body portals into its canvas from ONE fixed position in the React tree
 * (see surface-body.tsx) and the canvas is appended into whichever host slot is
 * live (surface-slot.tsx). React never sees a container change, so it never
 * unmounts: state, timers, in-flight fetches, stream subscriptions and scroll
 * offsets all survive.
 */

/** Live canvases by modal id. Off-record and non-serializable, like the detached-window registry. */
const canvases = new Map<string, HTMLDivElement>()

let stash: HTMLDivElement | null = null

/**
 * The offscreen home every canvas returns to when no host holds it -- i.e. while
 * the surface is PARKED.
 *
 * `content-visibility: hidden` is the point: it skips layout and paint for the
 * subtree while keeping it alive and, unlike `display: none`, preserves the
 * scroll offsets inside it so a restored surface comes back exactly where you
 * left it.
 */
function surfaceStash(): HTMLDivElement {
  if (stash?.isConnected) return stash
  const el = document.createElement('div')
  el.id = 'surface-stash'
  el.setAttribute('aria-hidden', 'true')
  el.style.setProperty('content-visibility', 'hidden')
  el.style.position = 'fixed'
  el.style.pointerEvents = 'none'
  el.style.width = '0'
  el.style.height = '0'
  el.style.overflow = 'hidden'
  document.body.appendChild(el)
  stash = el
  return el
}

/** The stable body host for a surface, created on first ask. */
export function getSurfaceCanvas(id: string): HTMLDivElement {
  const existing = canvases.get(id)
  if (existing) return existing
  const el = document.createElement('div')
  el.dataset.surfaceCanvas = id
  // `contents` = the canvas draws no box of its own, so the body lays out as a
  // direct child of whatever slot currently holds it. Reparenting therefore
  // changes nothing about the body's own layout.
  el.style.display = 'contents'
  canvases.set(id, el)
  surfaceStash().appendChild(el)
  return el
}

/** Send a canvas back to the stash (the surface is parked, or its host went away). */
export function parkSurfaceCanvas(id: string): void {
  const el = canvases.get(id)
  if (el) surfaceStash().appendChild(el)
}

/** The surface is CLOSED, not parked: drop the canvas so a re-open starts clean. */
export function disposeSurfaceCanvas(id: string): void {
  canvases.get(id)?.remove()
  canvases.delete(id)
}
