/**
 * Keep the inline card-link glyphs inside one rendered markdown block painted.
 *
 * Repaint is the whole update path: the anchors are injected HTML, so when the
 * provider cache changes we walk this block's links again rather than
 * re-rendering anything. A block with no card links subscribes to nothing.
 */

import type { RefObject } from 'react'
import { useEffect } from 'react'
import { resolveCard, subscribeCards } from '@/lib/cards'
import { paintCardGlyphs } from '@/lib/cards/paint-glyphs'

export function useCardGlyphs(containerRef: RefObject<HTMLElement | null>, htmlKey: string): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: htmlKey is the dep key; the ref is stable
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const refs = paintCardGlyphs(el)
    if (refs.length === 0) return
    for (const ref of refs) resolveCard(ref)
    return subscribeCards(() => {
      if (containerRef.current) paintCardGlyphs(containerRef.current)
    })
  }, [htmlKey])
}
