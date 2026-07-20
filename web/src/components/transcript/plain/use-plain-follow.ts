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
 *
 * TWO ENGINE QUIRKS WE COMPENSATE FOR (both browser-verified, v1.1.6):
 *
 * 1. SUB-THRESHOLD ESCAPE (the "append doesn't follow" bug). The engine's
 *    resize pin only fires when the RAW `state.isAtBottom` is true, but the
 *    lock escapes on ANY scroll-up -- including a sub-threshold nudge INSIDE
 *    the 70px near-bottom zone (layout jitter, a textarea/optimistic-bubble
 *    reflow when you post, a touch bounce). After such a nudge `isNearBottom`
 *    stays true (UI still reads "attached", `follow` stays true) yet raw
 *    `state.isAtBottom` is false, so the next append does NOT pin. We treat the
 *    parent `follow` prop as authoritative: a tail append while `follow` is on
 *    re-pins. A genuine detach scrolls >70px, which drops `follow` and gates
 *    this out -- a scrolled-away reader is never yanked.
 *
 * 2. ESTIMATE SETTLE ON SWITCH (the "doesn't always land at bottom" bug). A
 *    switch back to a cached conversation REMOUNTS the view, so every
 *    content-visibility group starts at its intrinsic-size ESTIMATE (no
 *    remembered height). A single pin lands at the estimated bottom; real
 *    heights then balloon scrollHeight and a post-switch re-anchor churns the
 *    window -- and if that divergence trips an escape, the reader is stranded.
 *    The switch-pin therefore SETTLES: it re-pins (ignoreEscapes) each frame
 *    until scrollHeight stops moving, not just once with a logging probe (the
 *    Open WebUI settle-re-pin gotcha).
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'

// Settle bound for the switch-pin: cap frames so a conversation whose content
// never stabilizes (pathological) can't spin the rAF loop forever, and require
// N consecutive stable frames so a mid-settle re-anchor can't end it early.
const SETTLE_MAX_FRAMES = 40 // ~660ms at 60fps
const SETTLE_STABLE_FRAMES = 2
const SETTLE_DRIFT_OK_PX = 4

export function usePlainFollow(opts: {
  cacheKey: string | undefined
  follow: boolean
  /** Changes when a new entry lands at the tail (last entry's seq). Drives the
   *  append re-pin that compensates for the engine's sub-threshold escape. */
  tailSignal: number
  onUserScroll?: () => void
  onReachedBottom?: () => void
}) {
  const engine = useStickToBottom({ initial: 'instant', resize: 'instant' })
  const { isAtBottom, scrollToBottom, stopScroll, state, scrollRef } = engine

  const followRef = useRef(opts.follow)
  followRef.current = opts.follow
  const tailSignalRef = useRef(opts.tailSignal)
  tailSignalRef.current = opts.tailSignal
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

  // SWITCH-PIN + SETTLE. Entering/switching a conversation always lands at the
  // bottom and re-engages follow. On a cached-conversation remount the
  // content-visibility groups open at their intrinsic-size estimate, so a
  // single pin lands short; we re-pin (ignoreEscapes, so the estimate->real
  // resize + post-switch re-anchor can't knock us off) each frame until
  // scrollHeight holds for SETTLE_STABLE_FRAMES. `prevTailRef` is synced here so
  // the append re-pin below treats the switch's tail change as positioning, not
  // an append.
  const prevTailRef = useRef(opts.tailSignal)
  // biome-ignore lint/correctness/useExhaustiveDependencies: cacheKey is the intentional trigger
  useLayoutEffect(() => {
    prevTailRef.current = tailSignalRef.current
    onReachedBottomRef.current?.()
    console.debug(`[follow] switch-pin (plain) cacheKey=${opts.cacheKey?.slice(0, 8) ?? '-'}`)
    let raf = 0
    let frames = 0
    let stable = 0
    let lastHeight = -1
    const settle = () => {
      scrollToBottom({ animation: 'instant', ignoreEscapes: true })
      const el = scrollRef.current
      const height = el?.scrollHeight ?? 0
      const drift = el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0
      stable = height === lastHeight && drift < SETTLE_DRIFT_OK_PX ? stable + 1 : 0
      lastHeight = height
      frames += 1
      if (stable >= SETTLE_STABLE_FRAMES || frames >= SETTLE_MAX_FRAMES) {
        console.debug(
          `[follow] switch-pin settled (plain) frames=${frames} drift=${drift.toFixed(0)} ${drift < 40 ? 'OK' : 'DID-NOT-REACH-BOTTOM'}`,
        )
        return
      }
      raf = requestAnimationFrame(settle)
    }
    raf = requestAnimationFrame(settle)
    return () => cancelAnimationFrame(raf)
  }, [opts.cacheKey])

  // APPEND RE-PIN. A new tail entry while `follow` is on must land at the
  // bottom even if a sub-threshold nudge silently escaped the engine's lock
  // (quirk 1). scrollToBottom re-asserts raw isAtBottom so continued streaming
  // follows again. Gated on `follow` (dropped by any real >70px scroll-up), so
  // a detached reader is never pulled down. Skipped on the switch commit, whose
  // tail change prevTailRef already absorbed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tailSignal is the intentional trigger
  useLayoutEffect(() => {
    if (opts.tailSignal === prevTailRef.current) return
    prevTailRef.current = opts.tailSignal
    if (!followRef.current) return
    console.debug('[follow] append re-pin (plain) -> follow tail')
    scrollToBottom({ animation: 'instant' })
  }, [opts.tailSignal])

  return engine
}
