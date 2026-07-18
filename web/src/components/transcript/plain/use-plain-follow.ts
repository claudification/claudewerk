/**
 * Follow engine for TranscriptViewPlain, wrapping `use-stick-to-bottom`
 * (StackBlitz; the engine inside Vercel AI Elements' Conversation).
 *
 * Why a library and not our hand-rolled signals: it enforces the ONE-WRITER
 * invariant this renderer is built on. Every programmatic write goes through
 * its tagged scrollTop setter (`ignoreScrollToTop`), scroll events inside a
 * ResizeObserver window are ignored for escape/engage decisions (the
 * layout-stability gate we used to hand-roll), wheel-up/scroll-up/selection
 * escape the lock, and a shrink near the bottom re-engages (turn-end collapse
 * never strands follow). All pins are configured INSTANT -- a smooth animation
 * chasing a moving streaming target caused visible overshoot on the TanStack
 * path (a18ff1f6); never reintroduce it for growth pins.
 *
 * The parent still owns the `follow` prop (shared with the events view + the
 * scroll-to-bottom button); this hook keeps engine state and parent state in
 * sync via onUserScroll/onReachedBottom, logging `[follow]` transitions.
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'

export function usePlainFollow(opts: {
  cacheKey: string | undefined
  follow: boolean
  onUserScroll?: () => void
  onReachedBottom?: () => void
}) {
  const engine = useStickToBottom({ initial: 'instant', resize: 'instant' })
  const { isAtBottom, scrollToBottom, stopScroll, state, scrollRef } = engine

  const followRef = useRef(opts.follow)
  followRef.current = opts.follow
  const onUserScrollRef = useRef(opts.onUserScroll)
  onUserScrollRef.current = opts.onUserScroll
  const onReachedBottomRef = useRef(opts.onReachedBottom)
  onReachedBottomRef.current = opts.onReachedBottom

  // ENGINE -> PARENT. The engine's isAtBottom (at-bottom OR near-bottom and not
  // escaped) is the single source of truth; mirror transitions up so the
  // scroll-to-bottom button and the shared follow prop stay correct.
  useEffect(() => {
    if (isAtBottom && !followRef.current) {
      console.debug('[follow] ENGAGE reason=reached-bottom (plain)')
      onReachedBottomRef.current?.()
    } else if (!isAtBottom && followRef.current) {
      console.debug('[follow] DISENGAGE reason=user-scroll-up (plain)')
      onUserScrollRef.current?.()
    }
  }, [isAtBottom])

  // PARENT -> ENGINE. Follow toggled ON while detached (scroll-to-bottom
  // button) -> instant pin. Toggled OFF while the engine still holds the lock
  // (some non-scroll path disabled follow) -> escape so growth stops pinning.
  const prevFollowRef = useRef(opts.follow)
  // biome-ignore lint/correctness/useExhaustiveDependencies: opts.follow is the intentional trigger; engine fns are stable
  useEffect(() => {
    const was = prevFollowRef.current
    prevFollowRef.current = opts.follow
    if (opts.follow === was) return
    const engineAtBottom = state.isAtBottom || state.isNearBottom
    if (opts.follow && !engineAtBottom) {
      console.debug('[follow] follow-prop=ON (plain) -> pin')
      scrollToBottom({ animation: 'instant' })
    } else if (!opts.follow && engineAtBottom) {
      console.debug('[follow] follow-prop=OFF (plain) -> escape lock')
      stopScroll()
    }
  }, [opts.follow])

  // SWITCH-PIN. Entering/switching a conversation always lands at the bottom
  // and re-engages follow (existing contract from the TanStack path). The
  // engine's resize pin converges any late-measuring content (lazy chunks,
  // content-visibility estimates settling -- the Open WebUI undershoot gotcha)
  // because we are at-bottom when those resizes fire. The rAF probe verifies.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cacheKey is the intentional trigger
  useLayoutEffect(() => {
    scrollToBottom({ animation: 'instant' })
    onReachedBottomRef.current?.()
    console.debug(`[follow] switch-pin (plain) cacheKey=${opts.cacheKey?.slice(0, 8) ?? '-'}`)
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current
      if (!el) return
      const drift = el.scrollHeight - el.scrollTop - el.clientHeight
      console.debug(
        `[follow] switch-pin settled (plain) drift=${drift.toFixed(0)} ${drift < 40 ? 'OK' : 'DID-NOT-REACH-BOTTOM'}`,
      )
    })
    return () => cancelAnimationFrame(raf)
  }, [opts.cacheKey])

  return engine
}
