/**
 * The display name of a canvas, by id, for surfaces that only ever learn the id
 * (a transcript entry sent from `canvas:<id>`).
 *
 * Cached per session because the transcript renders the same canvas over and
 * over: one fetch per canvas, shared by every entry that names it, and in-flight
 * requests are deduped so a burst of entries does not become a burst of GETs.
 * A failure caches nothing -- the caller falls back to the id, and a later
 * render may succeed.
 */

import { useEffect, useState } from 'react'
import { loadCanvas } from './canvas-editor-io'

const names = new Map<string, string>()
const inFlight = new Map<string, Promise<string | null>>()

function fetchName(canvasId: string): Promise<string | null> {
  const running = inFlight.get(canvasId)
  if (running) return running
  const p = loadCanvas(canvasId)
    .then(loaded => {
      const name = loaded?.canvas.name ?? null
      if (name) names.set(canvasId, name)
      return name
    })
    .catch(() => null)
    .finally(() => inFlight.delete(canvasId))
  inFlight.set(canvasId, p)
  return p
}

/** The canvas's name, or null until (or unless) it resolves. */
export function useCanvasName(canvasId: string | null): string | null {
  const [name, setName] = useState<string | null>(() => (canvasId ? (names.get(canvasId) ?? null) : null))

  useEffect(() => {
    if (!canvasId) return
    const cached = names.get(canvasId)
    if (cached) {
      setName(cached)
      return
    }
    let live = true
    void fetchName(canvasId).then(resolved => {
      if (live && resolved) setName(resolved)
    })
    return () => {
      live = false
    }
  }, [canvasId])

  return name
}
