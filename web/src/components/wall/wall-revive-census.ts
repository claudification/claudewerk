/**
 * THE CENSUS CHECK -- what the registry DECLARED against what actually
 * registered.
 *
 * This tiny file is the reason the RESILIENCE probe cannot be satisfied by a
 * stub. "A revive seam exists" is one `useEffect` behind one pane; the wall has
 * six pull feeds behind seven panes, and the failure this card was written for is
 * exactly the one where twelve of thirteen are wired and the thirteenth is
 * silently stale. So the assertion is not "does the seam exist" but "is the
 * declared census EMPTY once you subtract everything that really took a hold".
 *
 * It lives apart from both halves on purpose: `revive-store.ts` must not import
 * the registry (the registry imports its feed ids), and the registry must not
 * import runtime state. This is where the two meet, and nothing else does.
 */

import { registeredFeeds, type WallFeedId } from '@/lib/wall/revive-store'
import { WALL_PULL_FEEDS } from './wall-pane-registry'

/**
 * Feeds the registry says the wall pulls that NOTHING currently holds.
 *
 * Meaningful only with the whole surface mounted -- which is what the resilience
 * suite does before reading it. Non-empty there means a pane declared a pull feed
 * and never registered it, so that pane will not revive after a disconnect.
 */
export function unrevivedWallFeeds(): WallFeedId[] {
  const live = registeredFeeds()
  return [...WALL_PULL_FEEDS].filter(feed => !live.has(feed))
}
