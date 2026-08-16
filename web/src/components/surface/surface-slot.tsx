/**
 * SurfaceSlot -- where a host (inline dialog / detached window) asks for the
 * surface body to be placed.
 *
 * Mounting the slot claims the canvas; unmounting hands it back to the stash.
 * That single rule covers every transition without the hosts knowing about each
 * other: the Radix Dialog closing on a park unmounts its slot, and the canvas
 * parks itself.
 */

import { useLayoutEffect, useRef } from 'react'
import { getSurfaceCanvas, parkSurfaceCanvas } from './surface-canvas'

export function SurfaceSlot({ id, className }: { id: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    const canvas = getSurfaceCanvas(id)
    host.appendChild(canvas)
    return () => {
      // Only hand it back if we still hold it. On a host swap the incoming slot
      // may have claimed the canvas before this cleanup runs, and stashing it
      // then would yank the body out of the window that just took it.
      if (canvas.parentElement === host) parkSurfaceCanvas(id)
    }
  }, [id])

  return <div ref={ref} className={className} />
}
