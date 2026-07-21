/**
 * One canvas row in the Project Action Panel list: thumbnail, name, share badge,
 * age -- wrapped in the right-click / long-press menu.
 *
 * Split out of project-canvases-section.tsx so that file stays a list + fetch and
 * this stays presentation.
 */

import type { CanvasSummary } from '@shared/protocol'
import { appendShareParam } from '@/lib/share-mode'
import { CanvasRowMenu } from './canvas-row-menu'

/** "4m ago" / "3h ago" / "2d ago". */
function canvasAge(updatedAt: number, now = Date.now()): string {
  const mins = Math.floor((now - updatedAt) / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function Thumb({ canvas }: { canvas: CanvasSummary }) {
  if (!canvas.hasThumb) {
    return (
      <span className="w-10 h-8 grid place-items-center text-sky-400/40 border border-border/60 shrink-0 text-sm">
        ◳
      </span>
    )
  }
  return (
    <img
      src={appendShareParam(`/api/canvases/${canvas.id}/thumb`)}
      alt=""
      className="w-10 h-8 object-cover border border-border/60 shrink-0 bg-background"
    />
  )
}

export function CanvasListRow({ canvas, onOpen }: { canvas: CanvasSummary; onOpen: () => void }) {
  return (
    <CanvasRowMenu canvas={canvas}>
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left px-3 py-2 border border-border hover:border-sky-400/60 transition-colors flex items-center gap-2"
      >
        <Thumb canvas={canvas} />
        <span className="min-w-0 flex-1 flex items-center gap-2">
          <span className="text-xs font-mono text-sky-400/90 truncate flex-1">{canvas.name}</span>
          {canvas.shared && (
            <span className="text-[9px] uppercase tracking-wide text-emerald-400/80 shrink-0">shared</span>
          )}
          <span className="text-[10px] text-muted-foreground/70 shrink-0">{canvasAge(canvas.updatedAt)}</span>
        </span>
      </button>
    </CanvasRowMenu>
  )
}
