import { useCallback, useRef } from 'react'
import { edgeSwipeIntent, type SwipeStart } from './edge-swipe-intent'

/**
 * Both side-edge swipes behind ONE pair of touch handlers.
 *
 * They share handlers on purpose: two independent hooks would each want
 * `onTouchStart`/`onTouchEnd` on the same element, and composing them at the
 * call site is exactly the kind of glue that rots. The decision itself lives in
 * `edge-swipe-intent.ts`, which is pure and tested.
 */
export function useEdgeSwipe({ onFromLeft, onFromRight }: { onFromLeft?: () => void; onFromRight?: () => void }) {
  const startRef = useRef<SwipeStart | null>(null)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    if (!touch) return
    startRef.current = { x: touch.clientX, y: touch.clientY, t: Date.now() }
  }, [])

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = startRef.current
      startRef.current = null
      const touch = e.changedTouches[0]
      if (!start || !touch) return

      const intent = edgeSwipeIntent(start, { x: touch.clientX, y: touch.clientY, t: Date.now() }, window.innerWidth)
      if (intent === 'left') onFromLeft?.()
      else if (intent === 'right') onFromRight?.()
    },
    [onFromLeft, onFromRight],
  )

  return { onTouchStart, onTouchEnd }
}
