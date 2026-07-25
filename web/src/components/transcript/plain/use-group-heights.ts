/**
 * Real group heights for the plain renderer's `contain-intrinsic-size`.
 *
 * WHY THIS IS THE FIX AND NOT A NICETY: a `content-visibility: auto` box
 * occupies its `contain-intrinsic-size` while its contents are skipped, and
 * snaps to the real height the moment the browser decides it is relevant to
 * the user -- which, when you scroll UP, happens just above the viewport, so
 * everything below (including what you are reading) gets shoved. The flat
 * 200px seed we shipped with is off by up to an order of magnitude for a real
 * assistant turn, so every first encounter was a several-hundred-px shove that
 * some anchor then had to chase. Feed each box an accurate height instead and
 * there is nothing to chase.
 *
 * Heights land in the SHARED per-conversation size cache (group-sizing.ts), the
 * same one the virtualized renderer fills, so both renderers warm each other
 * and a conversation switch back reuses real numbers instead of re-estimating.
 * `contain-intrinsic-size: auto` remembers a rendered height too, but only for
 * a live DOM node -- a switch destroys those.
 */

import { type CSSProperties, useEffect, useMemo } from 'react'
import { getConvSizeCache, trimConvSizeCache } from '../group-sizing'
import { observeGroupBoxes } from './group-box-observer'

/** Is this box currently rendered (as opposed to skipped by
 *  content-visibility)? A skipped box reports its intrinsic-size ESTIMATE, and
 *  writing that into the measured cache would launder a guess into a fact.
 *  `checkVisibility` is the only way to ask; where it is missing we record
 *  anyway -- the value is then simply the estimate we already had, and the
 *  first real render overwrites it. */
function isRendered(el: HTMLElement): boolean {
  const check = (el as { checkVisibility?: (opts: { contentVisibilityAuto: boolean }) => boolean }).checkVisibility
  if (typeof check !== 'function') return true
  return check.call(el, { contentVisibilityAuto: true })
}

/** Observes every group box and records its real height into the shared cache.
 *  Returns the cache for the current conversation so the caller can size the
 *  boxes from it. */
export function useGroupHeights(
  contentRef: { current: HTMLElement | null },
  cacheKey: string | undefined,
  enabled = true,
): Map<string, number> {
  const sizes = useMemo(() => getConvSizeCache(cacheKey), [cacheKey])
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentRef is a stable engine identity
  useEffect(() => {
    const content = contentRef.current
    if (!content || !enabled) return
    return observeGroupBoxes(content, entries => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement
        const key = el.dataset.groupKey
        if (!key || !isRendered(el)) continue
        const height = entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight
        if (height > 0) sizes.set(key, height)
      }
      trimConvSizeCache(sizes)
    })
  }, [sizes, enabled])
  return sizes
}

// Style objects are shared by identity so a per-group inline style cannot make
// every group's props look new on every render. Heights are bucketed: a group
// whose real height wobbles by a few px reuses one object instead of minting a
// fresh one per commit, and the reserved height is never SHORT of the real one
// (round up) -- an underestimate is the direction that shoves content down.
const INTRINSIC_BUCKET_PX = 16
const INTRINSIC_MAX_PX = 8000
const intrinsicStyles = new Map<number, CSSProperties>()

/** `contain-intrinsic-size` style for a box of about `px` tall. `bucketPx` 1
 *  means "use this exact value" (the flat-sizing lab knob, which has one). */
export function intrinsicStyle(px: number, bucketPx = INTRINSIC_BUCKET_PX): CSSProperties {
  const bucket = Math.min(INTRINSIC_MAX_PX, Math.max(bucketPx, Math.ceil(px / bucketPx) * bucketPx))
  const existing = intrinsicStyles.get(bucket)
  if (existing) return existing
  const style: CSSProperties = { containIntrinsicSize: `auto ${bucket}px` }
  intrinsicStyles.set(bucket, style)
  return style
}
