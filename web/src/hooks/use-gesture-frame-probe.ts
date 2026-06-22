/**
 * use-gesture-frame-probe -- perf diagnostic for the mermaid pan/zoom lightbox.
 *
 * Gated by the perf monitor toggle (isPerfEnabled); a complete no-op when off.
 * While a gesture is live, a rAF loop records the real browser frame cadence (ms
 * between painted frames) + moves-per-frame under `mermaid.gesture-frame`, so the
 * perf HUD / web_perf_report shows the effective FPS under the cursor. Born from
 * the 7fps->60fps zoom investigation; kept as a regression guard that the
 * imperative transform path (see use-pan-zoom header) stays smooth.
 *
 * Returns `mark()` to call on each pan/zoom event. `getScale` must be stable
 * (wrap in useCallback) so the returned `mark` stays referentially stable.
 */

import { useCallback, useEffect, useRef } from 'react'
import { isPerfEnabled, record } from '@/lib/perf-metrics'

export function useGestureFrameProbe(getScale: () => number) {
  const lastActiveRef = useRef(0)
  const rafRef = useRef(0)
  const lastFrameRef = useRef(0)
  const moveCountRef = useRef(0)

  const mark = useCallback(() => {
    if (!isPerfEnabled()) return
    lastActiveRef.current = performance.now()
    moveCountRef.current++
    if (rafRef.current) return
    lastFrameRef.current = performance.now()
    const tick = () => {
      const now = performance.now()
      const dt = now - lastFrameRef.current
      lastFrameRef.current = now
      const moves = moveCountRef.current
      moveCountRef.current = 0
      record(
        'scroll',
        'mermaid.gesture-frame',
        dt,
        `${dt > 0 ? (1000 / dt).toFixed(0) : '-'}fps moves=${moves} scale=${getScale().toFixed(2)}`,
      )
      // Stop the loop ~400ms after the last interaction so it never spins idle.
      if (now - lastActiveRef.current > 400) {
        rafRef.current = 0
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [getScale])

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  return mark
}
