/**
 * Right-click (and long-press) menu for a canvas row in the Project Action Panel.
 *
 * Archive and delete had broker routes and no way to reach them from the UI at
 * all; rename was only reachable by opening the canvas first. This is where those
 * live now. Radix ContextMenu gives touch long-press for free, so the same menu
 * works on a phone.
 */

import type { CanvasSummary } from '@shared/protocol'
import { ContextMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { haptic } from '@/lib/utils'
import { archiveCanvas, deleteCanvas, duplicateCanvas, renameCanvas } from './canvas-editor-io'
import { openCanvasWindow } from './open-canvas-window'

const itemClass =
  'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'
const dangerClass = `${itemClass} text-red-400/90 data-[highlighted]:text-red-300`

function promptRename(canvas: CanvasSummary) {
  const next = window.prompt('Canvas name', canvas.name)?.trim()
  if (next && next !== canvas.name) void renameCanvas(canvas.id, next)
}

// Deleting drops the scene files too, so it is the one action with no undo --
// hence a confirm, while archive (reversible, just hidden) gets none.
function confirmDelete(canvas: CanvasSummary) {
  if (window.confirm(`Delete "${canvas.name}"? This cannot be undone.`)) void deleteCanvas(canvas.id)
}

export function CanvasRowMenu({ canvas, children }: { canvas: CanvasSummary; children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-44 border border-border bg-background py-1 shadow-lg z-50">
          <ContextMenu.Item
            className={itemClass}
            onSelect={() => {
              haptic('tap')
              openCanvasWindow(canvas.id)
            }}
          >
            Open
          </ContextMenu.Item>
          <ContextMenu.Item
            className={itemClass}
            onSelect={() => {
              haptic('tap')
              promptRename(canvas)
            }}
          >
            Rename…
          </ContextMenu.Item>
          <ContextMenu.Item
            className={itemClass}
            onSelect={() => {
              haptic('tap')
              void duplicateCanvas(canvas)
            }}
          >
            Duplicate
          </ContextMenu.Item>
          <ContextMenu.Separator className="h-px bg-border my-1" />
          <ContextMenu.Item
            className={itemClass}
            onSelect={() => {
              haptic('tap')
              void archiveCanvas(canvas.id, true)
            }}
          >
            Archive
          </ContextMenu.Item>
          <ContextMenu.Item
            className={dangerClass}
            onSelect={() => {
              haptic('tap')
              confirmDelete(canvas)
            }}
          >
            Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
