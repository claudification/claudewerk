/**
 * use-pan-zoom -- hand-rolled pan + zoom over a content element via a CSS
 * `translate()scale()` transform (no dep). Unified pointer events cover mouse
 * drag, trackpad/wheel zoom and touch pinch. Used by MermaidLightbox.
 *
 * Math: transform-origin is the content's top-left (0,0), so a zoom that keeps
 * the point under the cursor fixed is tx' = px - (px - tx) * (next/scale).
 *
 * PERF (why this is imperative, not React state): the transform is written
 * straight to `contentRef.current.style` in the event handlers -- NOT through a
 * setState per pointermove/wheel. Routing it through React re-rendered the whole
 * MermaidLightbox tree (Radix Dialog + toolbar + the dangerouslySetInnerHTML SVG
 * div) on every input event; Safari fires those events faster than frames, so
 * several full re-renders + layout passes piled up per frame -> ~130ms/frame
 * (~7fps). The transform itself paints at 60fps; React was the bottleneck. React
 * state now holds ONLY the zoom-% readout, synced rAF-coalesced (and skipped
 * entirely while panning, since scale doesn't change). Measured 7fps -> 60fps.
 */

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { useGestureFrameProbe } from './use-gesture-frame-probe'

const MIN_SCALE = 0.1
const MAX_SCALE = 12

interface Transform {
  scale: number
  tx: number
  ty: number
}

const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

export function usePanZoom(containerRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>) {
  // Live transform -- the source of truth during a gesture. Mutated in place and
  // flushed to the DOM imperatively; never drives a per-event re-render.
  const tRef = useRef<Transform>({ scale: 1, tx: 0, ty: 0 })
  // Only state that re-renders React: the zoom-% shown in the toolbar.
  const [scaleDisplay, setScaleDisplay] = useState(1)
  // Active pointers (id -> client coords) for drag + pinch tracking.
  const pointers = useRef<Map<number, { x: number; y: number }>>(null!)
  if (pointers.current === null) pointers.current = new Map()
  const pinchDist = useRef(0)

  // Write the current transform straight to the element (no React commit).
  const apply = useCallback(() => {
    const el = contentRef.current
    if (!el) return
    const t = tRef.current
    el.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})`
  }, [contentRef])

  // Sync the % readout to React, coalesced to one update per frame. No-op when
  // the scale is unchanged (React bails on equal state), so panning re-renders 0x.
  const syncRaf = useRef(0)
  const syncScale = useCallback(() => {
    if (syncRaf.current) return
    syncRaf.current = requestAnimationFrame(() => {
      syncRaf.current = 0
      setScaleDisplay(tRef.current.scale)
    })
  }, [])

  // Perf diagnostic (gated; no-op when the monitor is off). Records gesture frame
  // cadence -- regression guard that this imperative path stays ~60fps.
  const getScale = useCallback(() => tRef.current.scale, [])
  const markActivity = useGestureFrameProbe(getScale)

  useEffect(
    () => () => {
      if (syncRaf.current) cancelAnimationFrame(syncRaf.current)
    },
    [],
  )

  // Zoom around a container-relative anchor point, keeping it visually fixed.
  const zoomAt = useCallback(
    (nextScaleRaw: number, px: number, py: number) => {
      const prev = tRef.current
      const next = clamp(nextScaleRaw)
      const k = next / prev.scale
      tRef.current = { scale: next, tx: px - (px - prev.tx) * k, ty: py - (py - prev.ty) * k }
      apply()
      syncScale()
    },
    [apply, syncScale],
  )

  // Place content at `scale`, centered within the container.
  const place = useCallback(
    (scale: number) => {
      const c = containerRef.current
      const el = contentRef.current
      if (!c || !el) {
        tRef.current = { scale, tx: 0, ty: 0 }
        setScaleDisplay(scale)
        return
      }
      const cb = c.getBoundingClientRect()
      const tx = (cb.width - el.offsetWidth * scale) / 2
      const ty = (cb.height - el.offsetHeight * scale) / 2
      tRef.current = { scale, tx, ty }
      apply()
      setScaleDisplay(scale)
    },
    [containerRef, contentRef, apply],
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
      zoomAt(tRef.current.scale * factor, cb.width / 2, cb.height / 2)
    },
    [containerRef, zoomAt],
  )

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      markActivity()
      const cb = containerRef.current?.getBoundingClientRect()
      if (!cb) return
      const factor = Math.exp(-e.deltaY * 0.0015)
      zoomAt(tRef.current.scale * factor, e.clientX - cb.left, e.clientY - cb.top)
    },
    [containerRef, markActivity, zoomAt],
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
      zoomAt(tRef.current.scale * (dist / pinchDist.current), (a.x + b.x) / 2 - cb.left, (a.y + b.y) / 2 - cb.top)
    }
    pinchDist.current = dist
  }, [containerRef, zoomAt])

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const pts = pointers.current
      const prevPt = pts.get(e.pointerId)
      if (!prevPt) return
      markActivity()
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pts.size === 1) {
        // Pan: mutate translate + flush imperatively. Scale unchanged -> no React.
        const t = tRef.current
        t.tx += e.clientX - prevPt.x
        t.ty += e.clientY - prevPt.y
        apply()
      } else if (pts.size === 2) {
        handlePinch()
      }
    },
    [handlePinch, markActivity, apply],
  )

  const endPointer = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchDist.current = 0
  }, [])

  return {
    scale: scaleDisplay,
    fit,
    reset,
    zoomBy,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp: endPointer, onPointerCancel: endPointer },
  }
}
