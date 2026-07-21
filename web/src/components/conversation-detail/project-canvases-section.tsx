/**
 * Collapsible "Canvases" section for the ProjectActionPanel -- the project's
 * hosted Excalidraw canvases, listed alongside recaps + conversations. Each row
 * opens the full-screen editor (rclaude-canvas-open); the header "+ New" creates
 * a blank canvas and opens it. Unlike recaps this section always renders (it
 * carries the create affordance), refreshing on rclaude-canvas-changed.
 */

import type { CanvasSummary } from '@shared/protocol'
import { useCallback, useEffect, useState } from 'react'
import { openCanvasWindow } from '@/components/canvas/open-canvas-window'
import { appendShareParam } from '@/lib/share-mode'
import { haptic } from '@/lib/utils'

interface ListResponse {
  canvases?: CanvasSummary[]
}

async function fetchCanvases(projectUri: string): Promise<CanvasSummary[]> {
  const url = new URL('/api/canvases', window.location.origin)
  url.searchParams.set('projectUri', projectUri)
  const res = await fetch(appendShareParam(url.pathname + url.search))
  if (!res.ok) return []
  return ((await res.json()) as ListResponse).canvases ?? []
}

function canvasAge(updatedAt: number): string {
  const mins = Math.floor((Date.now() - updatedAt) / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Open a drawing in its own window; navigate this tab if the popup is blocked. */
function openCanvas(canvasId: string) {
  haptic('tap')
  if (!openCanvasWindow(canvasId)) window.location.href = `/canvas/${encodeURIComponent(canvasId)}`
}

async function createCanvas(projectUri: string) {
  haptic('tap')
  const res = await fetch('/api/canvases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectUri, name: 'Untitled canvas' }),
  })
  if (!res.ok) return
  const { canvas } = (await res.json()) as { canvas: CanvasSummary }
  window.dispatchEvent(new CustomEvent('rclaude-canvas-changed'))
  openCanvas(canvas.id)
}

export function ProjectCanvasesSection({ projectUri }: { projectUri: string }) {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([])
  const [collapsed, setCollapsed] = useState(false)

  const refresh = useCallback(() => {
    let cancelled = false
    void fetchCanvases(projectUri).then(items => {
      if (!cancelled) setCanvases(items.sort((a, b) => b.updatedAt - a.updatedAt))
    })
    return () => {
      cancelled = true
    }
  }, [projectUri])

  useEffect(() => refresh(), [refresh])
  useEffect(() => {
    const onChanged = () => refresh()
    window.addEventListener('rclaude-canvas-changed', onChanged)
    return () => window.removeEventListener('rclaude-canvas-changed', onChanged)
  }, [refresh])

  return (
    <div className="space-y-1">
      <div className="w-full text-[10px] text-sky-400/70 font-bold uppercase tracking-wider px-1 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            setCollapsed(c => !c)
          }}
          className="flex items-center gap-2 flex-1 min-w-0"
        >
          <span className="shrink-0 w-2 text-left">{collapsed ? '▸' : '▾'}</span>
          <span>Canvases ({canvases.length})</span>
          <span className="flex-1 h-px bg-sky-400/20" />
        </button>
        <button
          type="button"
          onClick={() => void createCanvas(projectUri)}
          className="shrink-0 text-sky-400/80 hover:text-sky-300 transition-colors"
          title="New canvas"
        >
          + New
        </button>
      </div>
      {!collapsed &&
        canvases.map(c => (
          <button
            key={c.id}
            type="button"
            onClick={() => openCanvas(c.id)}
            className="w-full text-left px-3 py-2 border border-border hover:border-sky-400/60 transition-colors flex items-center gap-2"
          >
            {c.hasThumb ? (
              <img
                src={appendShareParam(`/api/canvases/${c.id}/thumb`)}
                alt=""
                className="w-10 h-8 object-cover border border-border/60 shrink-0 bg-background"
              />
            ) : (
              <span className="w-10 h-8 grid place-items-center text-sky-400/40 border border-border/60 shrink-0 text-sm">
                ◳
              </span>
            )}
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="flex items-center gap-2">
                <span className="text-xs font-mono text-sky-400/90 truncate flex-1">{c.name}</span>
                {c.shared && (
                  <span className="text-[9px] uppercase tracking-wide text-emerald-400/80 shrink-0">shared</span>
                )}
                <span className="text-[10px] text-muted-foreground/70 shrink-0">{canvasAge(c.updatedAt)}</span>
              </span>
            </span>
          </button>
        ))}
    </div>
  )
}
