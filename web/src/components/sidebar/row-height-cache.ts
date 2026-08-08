/**
 * Real sidebar-row heights, remembered for the life of the page.
 *
 * WHY THIS IS THE FIX AND NOT A NICETY: sidebar rows are `content-visibility:
 * auto`, so an off-screen row occupies its `contain-intrinsic-size` instead of
 * its real height. `contain-intrinsic-size: auto` self-remembers a real height
 * -- but only for a row that has actually been rendered at least once. On the
 * first open of a session none have, so every unseen row reserves the same flat
 * fallback, `scrollIntoView` computes a target offset from those fake heights,
 * jumps there, and the rows it just revealed inflate to their true size and
 * shove the target back off screen. That is the "it scrolls and misses" bug.
 *
 * Same disease the transcript had; `transcript/group-sizing.ts` has the long
 * version and the same two-layer shape:
 *   1. a real measured height for this exact row, if we have ever seen it;
 *   2. the median of every row we HAVE seen -- rows are near-uniform, so one
 *      screenful of measurements makes the estimate for the other 200 good.
 * Only if we have seen nothing at all do we fall back to the caller's guess.
 *
 * Module scope, not React state, deliberately: reading a reserved height must
 * never re-render a row, and the cache must outlive any component.
 */

const heights = new Map<string, number>()

let medianCache: number | null = null

/** Record a row's real, rendered height. Ignores skipped/collapsed measurements. */
export function rememberRowHeight(id: string, px: number): void {
  // A `content-visibility` skipped row reports its RESERVED box, so recording
  // one would launder a guess into the cache as though it were a measurement.
  // Callers only pass rows they have confirmed rendered; this guard is for the
  // degenerate zero case (detached node, display:none ancestor).
  if (px <= 0) return
  const prev = heights.get(id)
  if (prev !== undefined && Math.abs(prev - px) < 0.5) return
  heights.set(id, px)
  medianCache = null
}

/** Median of every row height measured so far, or null if we have none. */
export function medianRowHeight(): number | null {
  if (medianCache !== null) return medianCache
  if (heights.size === 0) return null
  const sorted = [...heights.values()].sort((a, b) => a - b)
  medianCache = sorted[Math.floor(sorted.length / 2)]
  return medianCache
}

/**
 * The `contain-intrinsic-size` value for a row: its own measured height, else
 * the median of its neighbours, else the caller's static fallback.
 *
 * Keeps the `auto` keyword so the browser still self-corrects once the row has
 * been painted -- this only improves the height it reserves BEFORE that.
 */
export function reservedRowHeight(id: string, fallbackRem: number): string {
  const px = heights.get(id) ?? medianRowHeight()
  return px ? `auto ${Math.round(px)}px` : `auto ${fallbackRem}rem`
}

/**
 * Measure every row currently rendered inside `root` in ONE batch.
 *
 * Batched on purpose: reading `offsetHeight` per row as each one mounts forces a
 * synchronous layout per row (200 rows, 200 reflows). One pass over a settled
 * list flushes layout once and reads every row from that same flush.
 *
 * Only rows intersecting the scroll viewport are recorded -- those are the ones
 * the browser has definitely rendered rather than skipped, so their height is a
 * measurement and not the reserved guess reflected back at us.
 */
export function captureRowHeights(root: HTMLElement): void {
  const view = root.getBoundingClientRect()
  for (const el of root.querySelectorAll<HTMLElement>('[data-conversation-id]')) {
    const id = el.dataset.conversationId
    if (!id) continue
    const rect = el.getBoundingClientRect()
    if (rect.bottom < view.top || rect.top > view.bottom) continue
    rememberRowHeight(id, rect.height)
  }
}

/** Test seam -- the cache is module state and would otherwise leak between tests. */
export function __resetRowHeightCache(): void {
  heights.clear()
  medianCache = null
}
