/**
 * Drag-to-resize + fullscreen for a bottom-docked panel.
 *
 * Extracted from `debug-console`, which had accumulated the resize state, the
 * three pointer handlers and the fullscreen toggle alongside its log rendering.
 * Height is clamped to a fraction of the viewport so a drag can never leave the
 * panel taller than the window.
 */

import { useCallback, useRef, useState } from 'react'

export interface PanelResizeOptions {
  initialHeight: number
  minHeight: number
  /** Ceiling as a fraction of `window.innerHeight`. */
  maxHeightRatio: number
}

export function usePanelResize({ initialHeight, minHeight, maxHeightRatio }: PanelResizeOptions) {
  const [height, setHeight] = useState(initialHeight)
  const [fullscreen, setFullscreen] = useState(false)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      dragRef.current = { startY: e.clientY, startH: height }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [height],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return
      const maxH = window.innerHeight * maxHeightRatio
      // Dragging UP (smaller clientY) grows a bottom-docked panel.
      const delta = dragRef.current.startY - e.clientY
      setHeight(Math.min(maxH, Math.max(minHeight, dragRef.current.startH + delta)))
    },
    [minHeight, maxHeightRatio],
  )

  const onPointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  const toggleFullscreen = useCallback(() => setFullscreen(f => !f), [])

  return {
    height,
    fullscreen,
    toggleFullscreen,
    /** Spread onto the drag handle element. */
    dragHandlers: { onPointerDown, onPointerMove, onPointerUp },
  }
}
