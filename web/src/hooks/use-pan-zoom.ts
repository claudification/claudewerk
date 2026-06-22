/**
 * use-pan-zoom -- hand-rolled pan + zoom over a content element via a CSS
 * `translate()scale()` transform (no dep). Unified pointer events cover mouse
 * drag, trackpad/wheel zoom and touch pinch. Used by MermaidLightbox.
 *
 * Math: transform-origin is the content's top-left (0,0), so a zoom that keeps
 * the point under the cursor fixed is tx' = px - (px - tx) * (next/scale).
 */

import { type RefObject, useCallback, useRef, useState } from 'react'

const MIN_SCALE = 0.1
const MAX_SCALE = 12

interface Transform {
  scale: number
  tx: number
  ty: number
}

const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

export function usePanZoom(containerRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>) {
  const [t, setT] = useState<Transform>({ scale: 1, tx: 0, ty: 0 })
  // Active pointers (id -> client coords) for drag + pinch tracking.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchDist = useRef(0)

  // Zoom around a container-relative anchor point, keeping it visually fixed.
  const zoomAt = useCallback((nextScaleRaw: number, px: number, py: number) => {
    setT(prev => {
      const next = clamp(nextScaleRaw)
      const k = next / prev.scale
      return { scale: next, tx: px - (px - prev.tx) * k, ty: py - (py - prev.ty) * k }
    })
  }, [])

  // Place content at `scale`, centered within the container.
  const place = useCallback(
    (scale: number) => {
      const c = containerRef.current
      const el = contentRef.current
      if (!c || !el) return setT({ scale, tx: 0, ty: 0 })
      const cb = c.getBoundingClientRect()
      const tx = (cb.width - el.offsetWidth * scale) / 2
      const ty = (cb.height - el.offsetHeight * scale) / 2
      setT({ scale, tx, ty })
    },
    [containerRef, contentRef],
  )

  // Fit: largest scale (<=1) that shows the whole diagram with a little padding.
  const fit = useCallback(() => {
    const c = containerRef.current
    const el = contentRef.current
    if (!c || !el) return
    const cb = c.getBoundingClientRect()
    const pad = 32
    const s = clamp(Math.min((cb.width - pad) / el.offsetWidth, (cb.height - pad) / el.offsetHeight, 1))
    place(s)
  }, [containerRef, contentRef, place])

  const reset = useCallback(() => place(1), [place])

  const zoomBy = useCallback(
    (factor: number) => {
      const c = containerRef.current
      if (!c) return
      const cb = c.getBoundingClientRect()
      setT(prev => {
        const next = clamp(prev.scale * factor)
        const k = next / prev.scale
        const px = cb.width / 2
        const py = cb.height / 2
        return { scale: next, tx: px - (px - prev.tx) * k, ty: py - (py - prev.ty) * k }
      })
    },
    [containerRef],
  )

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      const cb = containerRef.current?.getBoundingClientRect()
      if (!cb) return
      const factor = Math.exp(-e.deltaY * 0.0015)
      setT(prev => {
        const next = clamp(prev.scale * factor)
        const k = next / prev.scale
        const px = e.clientX - cb.left
        const py = e.clientY - cb.top
        return { scale: next, tx: px - (px - prev.tx) * k, ty: py - (py - prev.ty) * k }
      })
    },
    [containerRef],
  )

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }, [])

  // Two-finger pinch: scale by the change in finger distance, around the midpoint.
  const handlePinch = useCallback(() => {
    const [a, b] = [...pointers.current.values()]
    const dist = Math.hypot(a.x - b.x, a.y - b.y)
    const cb = containerRef.current?.getBoundingClientRect()
    if (pinchDist.current && cb) {
      zoomAt(t.scale * (dist / pinchDist.current), (a.x + b.x) / 2 - cb.left, (a.y + b.y) / 2 - cb.top)
    }
    pinchDist.current = dist
  }, [containerRef, zoomAt, t.scale])

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const pts = pointers.current
      const prevPt = pts.get(e.pointerId)
      if (!prevPt) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pts.size === 1) {
        setT(prev => ({ ...prev, tx: prev.tx + (e.clientX - prevPt.x), ty: prev.ty + (e.clientY - prevPt.y) }))
      } else if (pts.size === 2) {
        handlePinch()
      }
    },
    [handlePinch],
  )

  const endPointer = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchDist.current = 0
  }, [])

  const transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})`
  return {
    scale: t.scale,
    transform,
    fit,
    reset,
    zoomBy,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp: endPointer, onPointerCancel: endPointer },
  }
}
