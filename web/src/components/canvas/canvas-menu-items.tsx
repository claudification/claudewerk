/**
 * Canvas entries for the project + pinned-project context menus -- a submenu
 * listing the project's drawings plus "New canvas".
 *
 * Mirrors the RecapMenuItems precedent: kept in its own file rather than grown
 * into conversation-context-menu.tsx, which is already far past the size bar.
 *
 * The list is fetched when the submenu OPENS, not with the menu: a right-click on
 * a project should not cost a request for a feature most clicks never touch.
 */

import type { CanvasSummary } from '@shared/protocol'
import { ContextMenu } from 'radix-ui'
import { useCallback, useEffect, useState } from 'react'
import { haptic } from '@/lib/utils'
import { createCanvas, listProjectCanvases } from './canvas-editor-io'
import { openCanvasWindow } from './open-canvas-window'

const itemClass =
  'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

/** Canvases for a project, loaded once the submenu is actually open. */
function useProjectCanvases(projectUri: string, open: boolean): CanvasSummary[] {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void listProjectCanvases(projectUri).then(items => {
      if (!cancelled) setCanvases(items)
    })
    return () => {
      cancelled = true
    }
  }, [projectUri, open])
  return canvases
}

function SubContent({ projectUri, open }: { projectUri: string; open: boolean }) {
  const canvases = useProjectCanvases(projectUri, open)
  return (
    <ContextMenu.SubContent className="min-w-52 border border-border bg-background py-1 shadow-lg z-50">
      <ContextMenu.Item
        className={itemClass}
        onSelect={() => {
          haptic('tap')
          void createCanvas(projectUri).then(c => c && openCanvasWindow(c.id))
        }}
      >
        New canvas
      </ContextMenu.Item>
      {canvases.length > 0 && <ContextMenu.Separator className="h-px bg-border my-1" />}
      {canvases.slice(0, 10).map(c => (
        <ContextMenu.Item
          key={c.id}
          className={itemClass}
          onSelect={() => {
            haptic('tap')
            openCanvasWindow(c.id)
          }}
        >
          <span className="truncate">{c.name}</span>
        </ContextMenu.Item>
      ))}
    </ContextMenu.SubContent>
  )
}

export function CanvasMenuItems({ projectUri }: { projectUri: string }) {
  const [open, setOpen] = useState(false)
  const onOpenChange = useCallback((next: boolean) => setOpen(next), [])
  return (
    <ContextMenu.Sub onOpenChange={onOpenChange}>
      <ContextMenu.SubTrigger className={itemClass}>
        Canvases <span className="ml-auto text-muted-foreground">{'▸'}</span>
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <SubContent projectUri={projectUri} open={open} />
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  )
}
