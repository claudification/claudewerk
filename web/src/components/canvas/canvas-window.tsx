/**
 * Standalone hosted-canvas WINDOW. Rendered by main.tsx when the path is
 * /canvas/:id -- NOT inside the app shell, so a drawing opens in its own
 * lightweight browser window (window.open) with just a thin header + the
 * Excalidraw surface (Phase E layers multiplayer cursors on top).
 *
 * All load/save/rename logic lives in useCanvasDocument; this is pure render.
 */

import type { CanvasSummary } from '@shared/protocol'
import ExcalidrawCanvas from '@/components/dialog/excalidraw-canvas'
import { canvasIdFromPath, type DocState, type SaveState, useCanvasDocument } from './use-canvas-document'

const SAVE_LABEL: Record<SaveState, string> = { idle: '', saving: 'saving...', saved: 'saved' }

function CanvasBody({
  state,
  canvas,
  seed,
  onSnapshot,
}: {
  state: DocState
  canvas: CanvasSummary | null
  seed: unknown
  onSnapshot: (json: string) => void
}) {
  if (state !== 'ready' || !canvas) {
    return (
      <div className="absolute inset-0 grid place-items-center text-muted-foreground text-sm">Loading canvas...</div>
    )
  }
  return <ExcalidrawCanvas key={canvas.id} initialSnapshot={seed} onSnapshot={onSnapshot} />
}

export function CanvasWindow() {
  const { canvas, seed, state, saveState, onSnapshot, onRename } = useCanvasDocument(canvasIdFromPath())

  if (state === 'missing') {
    return <div className="fixed inset-0 grid place-items-center text-muted-foreground text-sm">Canvas not found.</div>
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      <div className="flex items-center gap-3 px-3 h-9 border-b border-border shrink-0 text-xs">
        <button type="button" onClick={onRename} className="font-mono text-sky-400/90 hover:text-sky-300 truncate">
          {canvas?.name ?? 'Loading...'}
        </button>
        <span className="text-[10px] text-muted-foreground/60 shrink-0">{SAVE_LABEL[saveState]}</span>
      </div>
      <div className="flex-1 min-h-0 relative">
        <CanvasBody state={state} canvas={canvas} seed={seed} onSnapshot={onSnapshot} />
      </div>
    </div>
  )
}
