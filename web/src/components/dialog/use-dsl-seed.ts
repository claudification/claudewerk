/**
 * Seed (and re-seed) a DSL `Scene` into a live Excalidraw canvas through the imperative
 * API -- NO remount, so the user's pan/zoom survive an agent redraw. Async because a scene
 * with mermaid nodes parses them through the lazy mermaid runtime (see excalidraw-dsl-bind).
 *
 * Raw (non-DSL) snapshots seed via Excalidraw's `initialData` instead; this hook is a no-op
 * for them. The first successful seed also fits the viewport to the content.
 */
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { isDslScene } from '@shared/draw-dsl'
import { type RefObject, useEffect, useRef } from 'react'
import { dslToElements } from './excalidraw-dsl-bind'

export function useDslSeed(apiRef: RefObject<ExcalidrawImperativeAPI | null>, snapshot: unknown, ready: boolean): void {
  const firstSeed = useRef(true)
  useEffect(() => {
    if (!ready || !isDslScene(snapshot)) return
    let cancelled = false
    void dslToElements(snapshot).then(elements => {
      const api = apiRef.current
      if (cancelled || !api) return
      api.updateScene({ elements: elements as never })
      if (firstSeed.current) {
        firstSeed.current = false
        api.scrollToContent(elements as never, { fitToContent: true })
      }
    })
    return () => {
      cancelled = true
    }
  }, [snapshot, ready, apiRef])
}
