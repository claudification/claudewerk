/**
 * The canvas's own floating chrome -- name, save state, live presence and Share,
 * rendered as an ISLAND on top of the drawing surface rather than a header bar
 * above it.
 *
 * Why: a fixed header stole ~36px from every canvas forever, and it read as a
 * different app bolted on top of Excalidraw. Excalidraw already floats its own
 * controls as islands over a full-bleed canvas, so ours joins that layer through
 * the supported `renderTopRightUI` hook and the drawing surface gets the whole
 * window back. Styling follows claudewerk (sharp borders, mono) on purpose --
 * this is OUR chrome sitting in excalidraw's layout, not a skin of theirs.
 */

import type { CanvasPeer, CanvasSummary } from '@shared/protocol'
import { CanvasShareControl } from './canvas-share-control'
import type { SaveState } from './use-canvas-document'

const SAVE_LABEL: Record<SaveState, string> = { idle: '', saving: 'saving...', saved: 'saved' }

/** Live-presence dots for the peers currently in the room (self included). */
function PresenceDots({ peers }: { peers: CanvasPeer[] }) {
  if (peers.length < 2) return null
  return (
    <span className="flex items-center gap-1 shrink-0" title={`${peers.length} editing`}>
      {peers.slice(0, 5).map(p => (
        <span
          key={p.peerId}
          className="w-2.5 h-2.5 rounded-full border border-background"
          style={{ background: p.color }}
          title={p.name}
        />
      ))}
    </span>
  )
}

export interface CanvasIslandProps {
  canvas: CanvasSummary | null
  saveState: SaveState
  peers: CanvasPeer[]
  onRename: () => void
}

export function CanvasIsland({ canvas, saveState, peers, onRename }: CanvasIslandProps) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 border border-border bg-background/95 backdrop-blur text-xs shadow-lg max-w-[min(60vw,32rem)]">
      <button
        type="button"
        onClick={onRename}
        title="Rename canvas"
        className="font-mono text-sky-400/90 hover:text-sky-300 truncate min-w-0"
      >
        {canvas?.name ?? 'Loading...'}
      </button>
      <span className="text-[10px] text-muted-foreground/60 shrink-0">{SAVE_LABEL[saveState]}</span>
      <PresenceDots peers={peers} />
      {canvas && <CanvasShareControl canvas={canvas} />}
    </div>
  )
}
