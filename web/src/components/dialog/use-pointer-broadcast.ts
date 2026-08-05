/**
 * Throttled cursor broadcast for canvas multiplayer.
 *
 * Split out of excalidraw-canvas.tsx: it is a self-contained rule about WHEN to
 * put a pointer on the wire, and the component is better off just wearing it.
 */

import { useCallback, useRef } from 'react'
import type { CanvasCollabBinding, ExcalidrawProps } from './excalidraw-canvas-types'

/** Minimum gap between non-edge cursor frames. */
const THROTTLE_MS = 50

/**
 * onPointerUpdate fires on every mouse move, so plain frames are throttled. The
 * button EDGE (press/release) always flushes, throttle or not: Excalidraw only
 * starts a peer's laser trail on the 'down' frame and ends it on 'up', so a
 * dropped edge means a laser stroke that never draws or never stops.
 */
export function usePointerBroadcast(collab: CanvasCollabBinding | undefined): ExcalidrawProps['onPointerUpdate'] {
  const lastAt = useRef(0)
  const lastButton = useRef<'up' | 'down'>('up')
  const broadcast = useCallback<NonNullable<ExcalidrawProps['onPointerUpdate']>>(
    payload => {
      if (!collab) return
      const now = performance.now()
      const edge = payload.button !== lastButton.current
      if (!edge && now - lastAt.current < THROTTLE_MS) return
      lastAt.current = now
      lastButton.current = payload.button
      collab.onPointer(payload.pointer.x, payload.pointer.y, payload.pointer.tool, payload.button)
    },
    [collab],
  )
  return collab ? broadcast : undefined
}
