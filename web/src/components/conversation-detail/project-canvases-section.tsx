/**
 * Collapsible "Canvases" section for the ProjectActionPanel -- the project's
 * hosted Excalidraw canvases, listed alongside recaps + conversations. Each row
 * opens the full-screen editor (rclaude-canvas-open); the header "+ New" creates
 * a blank canvas and opens it. Unlike recaps this section always renders (it
 * carries the create affordance), refreshing on rclaude-canvas-changed.
 */

import type { CanvasSummary } from '@shared/protocol'
import { useCallback, useEffect, useState } from 'react'
import { createCanvas, listProjectCanvases } from '@/components/canvas/canvas-editor-io'
import { CanvasListRow } from '@/components/canvas/canvas-list-row'
import { openCanvasWindow } from '@/components/canvas/open-canvas-window'
import { haptic } from '@/lib/utils'

/** Open a drawing in its own window; navigate this tab if the popup is blocked. */
function openCanvas(canvasId: string) {
  haptic('tap')
  if (!openCanvasWindow(canvasId)) window.location.href = `/canvas/${encodeURIComponent(canvasId)}`
}

async function newCanvas(projectUri: string) {
  haptic('tap')
  const canvas = await createCanvas(projectUri)
  if (canvas) openCanvas(canvas.id)
}

export function ProjectCanvasesSection({ projectUri }: { projectUri: string }) {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([])
  const [collapsed, setCollapsed] = useState(false)

  const refresh = useCallback(() => {
    let cancelled = false
    void listProjectCanvases(projectUri).then(items => {
      if (!cancelled) setCanvases(items)
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
          onClick={() => void newCanvas(projectUri)}
          className="shrink-0 text-sky-400/80 hover:text-sky-300 transition-colors"
          title="New canvas"
        >
          + New
        </button>
      </div>
      {!collapsed && canvases.map(c => <CanvasListRow key={c.id} canvas={c} onOpen={() => openCanvas(c.id)} />)}
    </div>
  )
}
