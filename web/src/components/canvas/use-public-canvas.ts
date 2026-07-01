/**
 * Guest viewer state for a publicly shared canvas: load by token, seed the
 * editor, and (for comment/edit tiers) debounce-save back through the tier-gated
 * public route. `read` tier never saves. A rejected save (comment guest touched
 * the base design) surfaces as `rejected` so the UI can warn + reseed.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadPublicCanvas,
  type PublicCanvas,
  savePublicCanvasScene,
  sceneElementIds,
  tagAnnotations,
} from './public-canvas-io'

const SAVE_DEBOUNCE_MS = 1200

export type PublicState = 'loading' | 'ready' | 'missing'

export interface PublicCanvasDoc {
  doc: PublicCanvas | null
  seed: unknown
  state: PublicState
  saveState: 'idle' | 'saving' | 'saved' | 'rejected'
  onSnapshot: (json: string) => void
}

function parse(scene: string | null): unknown {
  if (!scene) return null
  try {
    return JSON.parse(scene)
  } catch {
    return null
  }
}

export function usePublicCanvas(token: string): PublicCanvasDoc {
  const [doc, setDoc] = useState<PublicCanvas | null>(null)
  const [seed, setSeed] = useState<unknown>(null)
  const [state, setState] = useState<PublicState>('loading')
  const [saveState, setSaveState] = useState<PublicCanvasDoc['saveState']>('idle')

  const baseIds = useRef<Set<string>>(null!)
  if (baseIds.current === null) baseIds.current = new Set()
  const tier = useRef<PublicCanvas['tier']>('read')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void loadPublicCanvas(token).then(loaded => {
      if (cancelled) return
      if (!loaded) return setState('missing')
      baseIds.current = sceneElementIds(loaded.scene)
      tier.current = loaded.tier
      setDoc(loaded)
      setSeed(parse(loaded.scene))
      setState('ready')
    })
    return () => {
      cancelled = true
    }
  }, [token])

  const onSnapshot = useCallback(
    (json: string) => {
      if (tier.current === 'read') return
      const payload = tier.current === 'comment' ? tagAnnotations(json, baseIds.current) : json
      setSaveState('saving')
      clearTimeout(timer.current)
      timer.current = setTimeout(async () => {
        const ok = await savePublicCanvasScene(token, payload)
        setSaveState(ok ? 'saved' : 'rejected')
      }, SAVE_DEBOUNCE_MS)
    },
    [token],
  )

  return { doc, seed, state, saveState, onSnapshot }
}
