/**
 * Follow engage/disengage signaling from scroll events.
 *
 * Only reacts to REAL user input (wheel/touch) -- programmatic scroll
 * adjustments from the virtualizer's anchor system cause small scrollTop
 * changes a naive handler misreads as "user scrolled away".
 *
 * LAYOUT-STABILITY GATE: a scroll event that coincides with a CONTENT or
 * VIEWPORT size change (backfill prepend, prune collapse, scrollback-spacer
 * re-estimate, iOS keyboard / composer resize) is layout-driven, not user
 * intent. Flipping follow state on it OSCILLATES: a bogus drift=0 ENGAGE
 * triggers the deferred prune-collapse, whose height shrink fires a bogus
 * DISENGAGE, which re-arms the backfill, which prepends and re-fires the
 * ENGAGE -- observed 2026-06-10 bouncing top/bottom with zero input.
 * Transitions only fire when scrollHeight, clientHeight AND the backfill
 * machinery were all stable across the event.
 */

import { useEffect, useRef } from 'react'
import { followDebug } from './follow-debug'

type Ref<T> = { current: T }

export type FollowTransition = 'engage' | 'disengage' | 'engage-suppressed' | 'disengage-suppressed' | null

/** Classify a scroll event. Engage band: drift < 40px. Disengage: user-driven
 *  scroll with drift > 120px (hysteresis gap between).
 *
 *  `unstable` (layout shifted OR a backfill in flight) suppresses ENGAGE ONLY.
 *  An ENGAGE rides on raw drift < 40 with no proof of user intent, so a
 *  layout-collapse frame can fake one -- that was the HEAD of the 2026-06-10
 *  oscillator, so it stays gated.
 *
 *  DISENGAGE is NEVER suppressed by instability. It already requires
 *  `userScrolling` (set only by real wheel/touch) AND drift > 120 -- proof of
 *  intent on its own. Suppressing it during a backfill DEADLOCKED the reader:
 *  scrolling up to read history is the very gesture that fires the backfill
 *  (loadEarlier/fetchOlder only trigger on a user scroll-up near the top), so
 *  `backfilling` was true exactly when the user-driven disengage needed to fire
 *  -> follow stuck ON -> the follow-gated window re-anchor ("post-scrollback-
 *  show-all") snapped the window back to the last page and the pin effect yanked
 *  the viewport to the bottom. Symptom: can't break through to load more; follow
 *  re-engages unless you keep fighting downward. The oscillator's disengage was
 *  only ever a downstream symptom of the bogus ENGAGE, which is still gated --
 *  so dropping the disengage suppression cannot revive it. */
export function classifyFollowTransition(drift: number, userScrolling: boolean, unstable: boolean): FollowTransition {
  if (drift < 40) return unstable ? 'engage-suppressed' : 'engage'
  if (userScrolling && drift > 120) return 'disengage'
  return null
}

/** One scroll-event measurement: current sizes, drift from bottom, and whether
 *  content/viewport size changed since the previous event (= layout-driven). */
function sampleScroll(el: HTMLElement, prevSh: number, prevCh: number) {
  const sh = el.scrollHeight
  const ch = el.clientHeight
  return {
    sh,
    ch,
    shDelta: sh - prevSh,
    layoutShifted: sh !== prevSh || ch !== prevCh,
    drift: sh - el.scrollTop - ch,
  }
}

function logTransition(
  t: Exclude<FollowTransition, null>,
  info: { drift: number; shDelta: number; userScrolling: boolean; cacheKey: string | undefined; backfilling: boolean },
): void {
  const towardEngage = t === 'engage' || t === 'engage-suppressed'
  let reason = 'layout-shift'
  if (t === 'engage') reason = 'reached-bottom'
  else if (t === 'disengage') reason = 'user-scroll-up'
  else if (info.backfilling) reason = 'backfill-in-flight'
  followDebug(
    `[follow] ${towardEngage ? 'ENGAGE' : 'DISENGAGE'}${t.endsWith('suppressed') ? '-suppressed' : ''} reason=${reason} drift=${info.drift.toFixed(0)} shDelta=${info.shDelta} userScrolling=${info.userScrolling} cacheKey=${info.cacheKey?.slice(0, 8) ?? '-'}`,
  )
}

export function useFollowSignals(opts: {
  parentRef: Ref<HTMLDivElement | null>
  follow: boolean
  onUserScroll?: () => void
  onReachedBottom?: () => void
  cacheKeyRef: Ref<string | undefined>
  loadingEarlierRef: Ref<boolean>
  fetchingOlderRef: Ref<boolean>
  userScrollingRef: Ref<boolean>
  userScrollResetRef: Ref<ReturnType<typeof setTimeout> | null>
}): void {
  const { parentRef, loadingEarlierRef, fetchingOlderRef, userScrollingRef, userScrollResetRef, cacheKeyRef } = opts
  const onUserScrollRef = useRef(opts.onUserScroll)
  onUserScrollRef.current = opts.onUserScroll
  const onReachedBottomRef = useRef(opts.onReachedBottom)
  onReachedBottomRef.current = opts.onReachedBottom
  // Mirror of the `follow` prop so the scroll handler can log only the genuine
  // ENGAGE/DISENGAGE transitions (not every qualifying scroll frame).
  const followStateRef = useRef(opts.follow)
  followStateRef.current = opts.follow

  // biome-ignore lint/correctness/useExhaustiveDependencies: listeners bind once to the mount-stable scroll element; all changing values are read through refs
  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    let userScrolling = false
    // `wheel` fires continuously across a desktop scroll, but `touchstart` fires
    // ONCE at the start of a finger drag -- by the time the drag has built up
    // drift > 120 (many frames later) this flag has long since reset on the next
    // rAF, so disengage never fired on mobile and the bottom-anchor yanked the
    // reader back down. `touchmove` fires every frame of an active drag, keeping
    // the flag alive through the whole gesture. A tap (drift ~0) still can't
    // disengage -- the drift > 120 gate guards the old "every touch detaches /
    // broke posting on mobile" regression.
    function onWheelOrTouch() {
      userScrolling = true
      requestAnimationFrame(() => {
        userScrolling = false
      })
      // Wider window for the load-trigger gate so momentum/inertia scroll still
      // counts as user-driven. Programmatic scrolls never call this handler.
      userScrollingRef.current = true
      if (userScrollResetRef.current) clearTimeout(userScrollResetRef.current)
      userScrollResetRef.current = setTimeout(() => {
        userScrollingRef.current = false
      }, 200)
    }
    let lastScrollHeight = el.scrollHeight
    let lastClientHeight = el.clientHeight
    // 15 lines, 4 inherent outcome branches (engage/disengage x fired/
    // suppressed); already split into sampleScroll + classifyFollowTransition
    // + logTransition. Further extraction adds indirection, not clarity.
    // fallow-ignore-next-line complexity
    function onScroll() {
      const s = sampleScroll(el!, lastScrollHeight, lastClientHeight)
      lastScrollHeight = s.sh
      lastClientHeight = s.ch
      const backfilling = loadingEarlierRef.current || fetchingOlderRef.current
      const t = classifyFollowTransition(s.drift, userScrolling, s.layoutShifted || backfilling)
      if (!t) return
      const towardEngage = t === 'engage' || t === 'engage-suppressed'
      // Log only genuine state TRANSITIONS (and the suppressions that blocked one).
      const isTransition = towardEngage ? !followStateRef.current : followStateRef.current
      if (isTransition)
        logTransition(t, {
          drift: s.drift,
          shDelta: s.shDelta,
          userScrolling,
          cacheKey: cacheKeyRef.current,
          backfilling,
        })
      if (t === 'engage') onReachedBottomRef.current?.()
      if (t === 'disengage') onUserScrollRef.current?.()
    }
    el.addEventListener('wheel', onWheelOrTouch, { passive: true })
    el.addEventListener('touchstart', onWheelOrTouch, { passive: true })
    el.addEventListener('touchmove', onWheelOrTouch, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheelOrTouch)
      el.removeEventListener('touchstart', onWheelOrTouch)
      el.removeEventListener('touchmove', onWheelOrTouch)
      el.removeEventListener('scroll', onScroll)
      if (userScrollResetRef.current) clearTimeout(userScrollResetRef.current)
    }
  }, [])
}
