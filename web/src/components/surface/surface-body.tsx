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
 */

import { type ReactNode, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { getSurfaceCanvas } from './surface-canvas'

export function SurfaceBody({ id, children }: { id: string; children: ReactNode }) {
  const canvas = useMemo(() => getSurfaceCanvas(id), [id])
  return createPortal(children, canvas)
}
