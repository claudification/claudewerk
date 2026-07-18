/**
 * Scrollback trigger for the plain renderer: a zero-height sentinel above the
 * first group, watched by an IntersectionObserver. Sentinel near the viewport
 * + more history -> load. Replaces scroll-event-driven backfill entirely:
 *
 * - No scroll RANGE required, so a loaded window shorter than the viewport can
 *   still reach older history (the phantom-spacer machinery this deletes).
 * - No user-gesture gating needed: programmatic pins scroll AWAY from the
 *   sentinel, so they can never trigger a load -- the old snowball
 *   (switch-snap -> load -> prune storm) is structurally impossible.
 * - Backfill and follow-intent no longer share a signal path (the 416ce442
 *   suppressed-disengage deadlock class).
 *
 * The observer is recreated whenever `reobserveKey` changes (each prepend):
 * IntersectionObserver always delivers an initial entry on observe(), so if
 * the sentinel is STILL visible after a load (short window, tall viewport) the
 * next chunk loads immediately -- chained via React commits, bounded by
 * hasMore, no polling loop.
 */

import { useEffect, useRef } from 'react'

export function TopSentinel({
  scrollRef,
  reobserveKey,
  onNearTop,
}: {
  scrollRef: { current: HTMLElement | null }
  /** Changes after each prepend/reveal -- forces a fresh initial IO callback. */
  reobserveKey: string | number
  /** Called when the sentinel is within the load margin. Re-entrancy guarding
   *  is the caller's job (loadingEarlierRef / fetchingOlderRef). */
  onNearTop: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const onNearTopRef = useRef(onNearTop)
  onNearTopRef.current = onNearTop

  // biome-ignore lint/correctness/useExhaustiveDependencies: reobserveKey is the intentional re-observe trigger (observe() always delivers an initial entry)
  useEffect(() => {
    const el = ref.current
    const root = scrollRef.current
    if (!el || !root) return
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) onNearTopRef.current()
      },
      // Start loading while the sentinel is still 400px above the viewport --
      // same lead distance the scroll-driven trigger used.
      { root, rootMargin: '400px 0px 0px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [scrollRef, reobserveKey])

  return <div ref={ref} aria-hidden className="h-px" />
}
