/**
 * The shared scaffolding of a drag-to-reorder row: the dnd-kit wiring, the
 * transform style, the dragging state, and the grip button that activates it.
 *
 * Extracted because the Organize Projects modal and the Workspaces manager had
 * grown byte-identical copies of it -- two places to get `setActivatorNodeRef`
 * or `touch-none` wrong.
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const GRIP = 'cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-foreground touch-none shrink-0'

export function SortableRow({
  id,
  gripTitle = 'Drag',
  className,
  draggingClassName = 'opacity-40 z-10 relative',
  children,
}: {
  id: string
  gripTitle?: string
  /** Classes for the row in its resting state. */
  className?: string
  draggingClassName?: string
  /** Row content, rendered after the grip. */
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(className, isDragging && draggingClassName)}
    >
      <button type="button" ref={setActivatorNodeRef} className={GRIP} title={gripTitle} {...attributes} {...listeners}>
        <GripVertical className="size-3.5" />
      </button>
      {children}
    </div>
  )
}
