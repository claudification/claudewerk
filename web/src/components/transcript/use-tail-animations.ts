/**
 * Tail-group animation state, shared by both transcript renderers.
 *
 * ENTER: slide-up + fade-in the newest group, ONLY for a live new entry while
 * idle. Detection runs during RENDER (via refs) so eligibility is computed
 * against the same values the row first paints with; the state update fires in
 * an effect so it lands AFTER the pin-to-bottom has the row in view. Verified
 * (real-browser harness): opacity + transform are composited, so measurement
 * observers never re-fire and scrollTop never moves.
 *
 * SETTLE: when the streaming TEXT buffer clears (a turn just committed), the
 * committed assistant entry has taken over the live slot in place -- tag that
 * tail group so its wrapper plays `assistant-settle` (globals.css).
 *
 * Eligibility for ENTER (all must hold): the LAST group's key changed, same
 * conversation (not a switch), same window anchor (not a head prepend -- a
 * head-prune does NOT move the anchor, so it never suppresses a genuine
 * slide-in), there was a previous tail (not first paint), and the turn is not
 * live (streaming IS the animation; a slide-in there would flash/jerk).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'

// Moved VERBATIM out of transcript-view.tsx; the render-phase edge detection is
// the point (see header) -- splitting it would separate detection from firing.
// fallow-ignore-next-line complexity
export function useTailAnimations(opts: {
  conversationId: string
  cacheKey: string | undefined
  /** Stable key of the last main group (null when empty). */
  tailKey: string | null
  /** Type of the last main group ('assistant' gates the settle morph). */
  tailType: string | null
  windowAnchorSeq: number | null
  liveActive: boolean
}): {
  enteringKey: string | null
  settlingKey: string | null
  clearEntering: () => void
  clearSettling: () => void
} {
  const { conversationId, cacheKey, tailKey, tailType, windowAnchorSeq, liveActive } = opts

  // ENTER ANIMATION STATE.
  const [enteringKey, setEnteringKey] = useState<string | null>(null)
  const prevTailKeyRef = useRef<string | null>(null)
  const enterCacheKeyRef = useRef(cacheKey)
  const enterWindowAnchorRef = useRef(windowAnchorSeq)
  const shouldEnter =
    tailKey !== null &&
    tailKey !== prevTailKeyRef.current &&
    prevTailKeyRef.current !== null &&
    cacheKey === enterCacheKeyRef.current &&
    windowAnchorSeq === enterWindowAnchorRef.current &&
    !liveActive
  const pendingEnterRef = useRef<string | null>(null)
  if (shouldEnter) pendingEnterRef.current = tailKey
  prevTailKeyRef.current = tailKey
  enterCacheKeyRef.current = cacheKey
  enterWindowAnchorRef.current = windowAnchorSeq
  // biome-ignore lint/correctness/useExhaustiveDependencies: tailKey is the intentional trigger
  useEffect(() => {
    const key = pendingEnterRef.current
    if (key) {
      pendingEnterRef.current = null
      setEnteringKey(key)
    }
  }, [tailKey])
  const clearEntering = useCallback(() => setEnteringKey(null), [])

  // SETTLE MORPH. Detected during render off the true->false edge of the
  // streaming-text buffer.
  const [settlingKey, setSettlingKey] = useState<string | null>(null)
  const streamingTextPresent = useConversationsStore(state =>
    conversationId ? !!state.streamingText[conversationId] : false,
  )
  const prevStreamingTextRef = useRef(streamingTextPresent)
  const pendingSettleRef = useRef<string | null>(null)
  if (prevStreamingTextRef.current && !streamingTextPresent && tailKey !== null && tailType === 'assistant') {
    pendingSettleRef.current = tailKey
  }
  prevStreamingTextRef.current = streamingTextPresent
  // biome-ignore lint/correctness/useExhaustiveDependencies: streamingTextPresent is the intentional trigger
  useEffect(() => {
    const key = pendingSettleRef.current
    if (key) {
      pendingSettleRef.current = null
      setSettlingKey(key)
    }
  }, [streamingTextPresent])
  const clearSettling = useCallback(() => setSettlingKey(null), [])

  return { enteringKey, settlingKey, clearEntering, clearSettling }
}
