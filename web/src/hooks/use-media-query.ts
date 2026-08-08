import { useSyncExternalStore } from 'react'
import { SIDEBAR_OVERLAY_QUERY } from '@/lib/breakpoints'

/**
 * Subscribe to a media query. `useSyncExternalStore` rather than
 * useState+useEffect so the first render already has the right answer -- a
 * one-frame wrong value here means the sidebar renders docked and then snaps to
 * overlay, which reads as a flash of the wrong layout on every load.
 */
function useMediaQuery(query: string): boolean {
  const mql = getQuery(query)
  return useSyncExternalStore(
    onChange => {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => mql.matches,
    () => false,
  )
}

// MediaQueryList objects are cached per query string: `matchMedia` returns a new
// object each call, and a new object every render would resubscribe forever.
const cache = new Map<string, MediaQueryList>()
function getQuery(query: string): MediaQueryList {
  const hit = cache.get(query)
  if (hit) return hit
  const mql = window.matchMedia(query)
  cache.set(query, mql)
  return mql
}

/** True when the sidebar overlays the content instead of docking beside it. */
export function useIsSidebarOverlay(): boolean {
  return useMediaQuery(SIDEBAR_OVERLAY_QUERY)
}
