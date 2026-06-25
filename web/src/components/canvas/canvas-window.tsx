/**
 * Hosted-canvas surface -- a thin header + the Excalidraw surface. Rendered in
 * two homes off the SAME `CanvasSurface`:
 *   - the standalone /canvas/:id route (main.tsx), for deep-links + share, and
 *   - a portal popout (PopoutHost), the default in-app open, which keeps the
 *     drawing in the parent React tree (no second document/WS/bundle).
 *
 * All load/save/rename logic lives in useCanvasDocument, which is target-window
 * aware -- in a popout it titles + flush-saves the POPUP, not the parent tab.
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

export function CanvasSurface({ canvasId }: { canvasId: string | null }) {
  const { canvas, seed, state, saveState, onSnapshot, onRename } = useCanvasDocument(canvasId)

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

/** Standalone /canvas/:id route entry -- keys the canvas off the path. */
export function CanvasWindow() {
  return <CanvasSurface canvasId={canvasIdFromPath()} />
}
