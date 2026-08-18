/**
 * SurfaceBody -- the ONE fixed position in the React tree where a managed
 * surface's body lives, for as long as the surface exists.
 *
 * It portals into the surface's canvas, whose identity never changes while the
 * surface is open, so React never unmounts the body no matter which host is
 * currently showing it. Moving the surface between inline / docked / detached is
 * a DOM `appendChild` of the canvas (surface-slot.tsx), not a re-render.
 *
 * The canvas is disposed by the manager's `close()`, not here: close is the one
 * explicit "this surface is gone" event, and tying disposal to an unmount effect
 * would fight StrictMode's double-invoke.
 *
 * It also OWNS the popout portal container for its subtree. That is not an extra
 * job, it is a consequence of the one above: because the body lives at a fixed
 * position in the MAIN tree and only its canvas DOM node travels, React context
 * does NOT flow from `PopoutWindow` down into it. The provider therefore has to
 * be re-established here, where the body actually renders, or every nested Radix
 * portal (the card editor, LAUNCH, RUN, every Select) reads `null` and lands in
 * the opener's document -- i.e. clicking a card in a detached board opened the
 * editor in the MAIN window.
 */

import { type ReactNode, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { PopoutContainerContext } from '../popout/popout-container-context'
import { getSurfaceCanvas } from './surface-canvas'

export function SurfaceBody({
  id,
  container,
  children,
}: {
  id: string
  /** The detached window's `document.body`, or null when hosted in the main window. */
  container?: HTMLElement | null
  children: ReactNode
}) {
  const canvas = useMemo(() => getSurfaceCanvas(id), [id])
  return createPortal(
    <PopoutContainerContext.Provider value={container ?? null}>{children}</PopoutContainerContext.Provider>,
    canvas,
  )
}
