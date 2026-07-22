/**
 * The canvas's own floating chrome -- save orb, rename, live presence and Share,
 * rendered as an ISLAND on top of the drawing surface rather than a header bar
 * above it.
 *
 * Why: a fixed header stole ~36px from every canvas forever, and it read as a
 * different app bolted on top of Excalidraw. Excalidraw already floats its own
 * controls as islands over a full-bleed canvas, so ours joins that layer through
 * the supported `renderTopRightUI` hook and the drawing surface gets the whole
 * window back. Styling follows claudewerk (sharp borders, mono) on purpose --
 * this is OUR chrome sitting in excalidraw's layout, not a skin of theirs.
 *
 * The canvas NAME is not shown here anymore: this is a dedicated window, so the
 * name lives in the browser `<title>` (the tab). A pencil renames it.
 */

import type { CanvasPeer, CanvasSummary } from '@shared/protocol'
import { Pencil } from 'lucide-react'
import { PresenceDots } from './canvas-presence-dots'
import { CanvasSaveOrb } from './canvas-save-orb'
import type { SaveStateStore } from './canvas-save-store'
import { CanvasShareControl } from './canvas-share-control'

export interface CanvasIslandProps {
  canvas: CanvasSummary | null
  saveStore: SaveStateStore
  peers: CanvasPeer[]
  onRename: () => void
}

export function CanvasIsland({ canvas, saveStore, peers, onRename }: CanvasIslandProps) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 border border-border bg-background/95 backdrop-blur text-xs shadow-lg">
      <CanvasSaveOrb store={saveStore} />
      <button
        type="button"
        onClick={onRename}
        title="Rename canvas"
        aria-label="Rename canvas"
        className="shrink-0 text-muted-foreground hover:text-sky-300 transition-colors"
      >
        <Pencil className="size-3" />
      </button>
      <PresenceDots peers={peers} />
      {canvas && <CanvasShareControl canvas={canvas} />}
    </div>
  )
}
