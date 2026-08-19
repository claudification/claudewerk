/**
 * The virtualized renderer's half of the transcript-search jump.
 *
 * The plain sibling can just call scrollIntoView on a real DOM node
 * (plain/use-plain-jump-scroll.ts); here the target may not be mounted at all,
 * so the scroll goes through the virtualizer's index math instead. Everything
 * before this step -- fetch, reveal, "which group holds the seq" -- is shared
 * in use-transcript-jump.ts.
 */

import { useEffect } from 'react'
import type { DisplayGroup } from './grouping'

interface JumpScrollTarget {
  scrollToIndex: (index: number, opts?: { align?: 'start' | 'center' | 'end' | 'auto' }) => void
}

export function useVirtualJumpScroll(
  virtualizer: JumpScrollTarget,
  renderGroups: DisplayGroup[],
  /** Index lookup keyed the same way the virtualizer keys its items. */
  getItemKey: (index: number) => string,
  groupKey: string | null,
  onLanded: () => void,
): void {
  useEffect(() => {
    if (!groupKey) return
    let index = -1
    for (let i = 0; i < renderGroups.length; i++) {
      if (getItemKey(i) === groupKey) {
        index = i
        break
      }
    }
    if (index < 0) {
      console.debug(`[jump] group ${groupKey} not in renderGroups yet`)
      return
    }
    console.debug(`[jump] scrollToIndex ${index} (group ${groupKey})`)
    virtualizer.scrollToIndex(index, { align: 'center' })
    onLanded()
  }, [groupKey, renderGroups, getItemKey, virtualizer, onLanded])
}
