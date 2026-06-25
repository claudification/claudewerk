/**
 * Canvas document hook: owns load + debounced save + close-flush + rename for a
 * single hosted canvas, keyed off the /canvas/:id path. Split out of
 * canvas-window.tsx so the component stays a thin render.
 */

import type { CanvasSummary } from '@shared/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePopoutWindow } from '@/components/popout/popout-window'
import { loadCanvas, renameCanvas, saveCanvasScene } from './canvas-editor-io'

const SAVE_DEBOUNCE_MS = 1500
export type SaveState = 'idle' | 'saving' | 'saved'
export type DocState = 'loading' | 'ready' | 'missing'

/** Canvas id from /canvas/:id (last non-empty path segment). */
export function canvasIdFromPath(): string | null {
  const seg = window.location.pathname.split('/').filter(Boolean)
  return seg[0] === 'canvas' && seg[1] ? decodeURIComponent(seg[1]) : null
}

function parseScene(scene: string | null): unknown {
  if (!scene) return null
  try {
    return JSON.parse(scene)
  } catch {
    return null
  }
}

export interface CanvasDocument {
  canvas: CanvasSummary | null
  seed: unknown
  state: DocState
  saveState: SaveState
  onSnapshot: (json: string) => void
  onRename: () => void
}

export function useCanvasDocument(id: string | null): CanvasDocument {
  // In a popout, title/flush/prompt must target the POPUP window, not the parent
  // tab; usePopoutWindow falls back to the global window/document when inline.
  const { win, doc } = usePopoutWindow()
  const [canvas, setCanvas] = useState<CanvasSummary | null>(null)
  const [seed, setSeed] = useState<unknown>(null)
  const [state, setState] = useState<DocState>('loading')
  const [saveState, setSaveState] = useState<SaveState>('idle')

  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const json = pending.current
    if (!id || json == null) return
    pending.current = null
    setSaveState('saving')
    await saveCanvasScene(id, json)
    setSaveState('saved')
  }, [id])

  useEffect(() => {
    if (!id) return setState('missing')
    let cancelled = false
    void loadCanvas(id).then(loaded => {
      if (cancelled) return
      if (!loaded) return setState('missing')
      doc.title = `${loaded.canvas.name} -- canvas`
      setCanvas(loaded.canvas)
      setSeed(parseScene(loaded.scene))
      setState('ready')
    })
    return () => {
      cancelled = true
    }
  }, [id, doc])

  // Best-effort save when the window is closing (debounce may not have fired yet).
  // In a popout this is the POPUP's close, flushing before it goes away.
  useEffect(() => {
    const onUnload = () => {
      if (pending.current == null || !id) return
      navigator.sendBeacon?.(
        `/api/canvases/${encodeURIComponent(id)}/scene`,
        new Blob([JSON.stringify({ scene: pending.current })], { type: 'application/json' }),
      )
    }
    win.addEventListener('beforeunload', onUnload)
    return () => win.removeEventListener('beforeunload', onUnload)
  }, [id, win])

  const onSnapshot = useCallback(
    (json: string) => {
      pending.current = json
      setSaveState('saving')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
    },
    [flush],
  )

  const onRename = useCallback(() => {
    if (!canvas) return
    const name = win.prompt('Canvas name', canvas.name)?.trim()
    if (!name || name === canvas.name) return
    setCanvas({ ...canvas, name })
    doc.title = `${name} -- canvas`
    void renameCanvas(canvas.id, name)
  }, [canvas, win, doc])

  return { canvas, seed, state, saveState, onSnapshot, onRename }
}
