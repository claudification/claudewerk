/**
 * Canvas document hook: owns load + debounced save + close-flush + rename for a
 * single hosted canvas, keyed off the /canvas/:id path. Split out of
 * canvas-window.tsx so the component stays a thin render.
 */

import type { CanvasSummary } from '@shared/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { loadCanvas, renameCanvas, saveCanvasScene } from './canvas-editor-io'
import { getCanvasPeerId } from './canvas-peer-id'
import { createSaveStateStore, type SaveStateStore } from './canvas-save-store'

const SAVE_DEBOUNCE_MS = 1500
export type DocState = 'loading' | 'ready' | 'missing'

function saveErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Save failed'
}

function reportSave(store: SaveStateStore, ok: boolean): void {
  if (ok) store.set('saved')
  else store.set('error', 'Server rejected the save')
}

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
  /** Live save state, read via useSyncExternalStore so it never re-renders the
   *  canvas surface -- only the orb that subscribes to it. */
  saveStore: SaveStateStore
  onSnapshot: (json: string) => void
  onRename: () => void
}

export function useCanvasDocument(id: string | null): CanvasDocument {
  // The canvas always owns its document now (standalone /canvas/:id window), so
  // title/flush/prompt target the globals directly -- see open-canvas-window.ts
  // for why excalidraw can never be portaled into someone else's window.
  const win = window
  const doc = document
  const [canvas, setCanvas] = useState<CanvasSummary | null>(null)
  const [seed, setSeed] = useState<unknown>(null)
  const [state, setState] = useState<DocState>(id ? 'loading' : 'missing')

  // Lazy init -> one store instance for the hook's life, no init branch.
  const [saveStore] = useState(createSaveStateStore)

  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const json = pending.current
    if (!id || json == null) return
    pending.current = null
    saveStore.set('saving')
    try {
      reportSave(saveStore, await saveCanvasScene(id, json))
    } catch (err) {
      saveStore.set('error', saveErrorMessage(err))
    }
  }, [id, saveStore])

  // react-doctor-disable-next-line react-doctor/no-derived-state -- multi-source: state set synchronously from prop AND asynchronously from loadCanvas
  const [prevId, setPrevId] = useState(id)
  if (id !== prevId) {
    setPrevId(id)
    if (!id) setState('missing')
  }

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setState('loading')
    void loadCanvas(id).then(loaded => {
      if (cancelled) return
      if (!loaded) return setState('missing')
      doc.title = loaded.canvas.name
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
      // peerId rides along here too -- the room may outlive this tab's unload
      // (another window, a share guest), and an unnamed write would reach them
      // as an agent write. See canvas-peer-id.ts.
      navigator.sendBeacon?.(
        `/api/canvases/${encodeURIComponent(id)}/scene`,
        new Blob([JSON.stringify({ scene: pending.current, peerId: getCanvasPeerId(id) })], {
          type: 'application/json',
        }),
      )
    }
    win.addEventListener('beforeunload', onUnload)
    return () => win.removeEventListener('beforeunload', onUnload)
  }, [id, win])

  const onSnapshot = useCallback(
    (json: string) => {
      pending.current = json
      saveStore.set('saving')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
    },
    [flush, saveStore],
  )

  const onRename = useCallback(() => {
    if (!canvas) return
    const name = win.prompt('Canvas name', canvas.name)?.trim()
    if (!name || name === canvas.name) return
    setCanvas({ ...canvas, name })
    doc.title = name
    void renameCanvas(canvas.id, name)
  }, [canvas, win, doc])

  return { canvas, seed, state, saveStore, onSnapshot, onRename }
}
