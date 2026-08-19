import { useDroppable } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CornerUpLeft, GripVertical, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { type ProjectOrderGroup, projectPath } from '@/lib/types'
import { cn } from '@/lib/utils'
import { SortableRow } from '../ui/sortable-row'

const grip = 'cursor-grab active:cursor-grabbing text-fg-faint hover:text-foreground touch-none shrink-0'

export function ProjectRow({
  id,
  label,
  count,
  onUngroup,
}: {
  id: string
  label: string
  count: number
  onUngroup?: () => void
}) {
  return (
    <SortableRow
      id={id}
      className="flex items-center gap-2 py-1 px-2 rounded border border-border bg-background text-xs"
    >
      <span className="flex-1 truncate" title={projectPath(id)}>
        {label}
      </span>
      {count > 0 && <span className="text-fg-faint tabular-nums">{count}</span>}
      {onUngroup && (
        <button
          type="button"
          onClick={onUngroup}
          className="text-fg-faint hover:text-foreground shrink-0"
          title="Move out of group"
        >
          <CornerUpLeft className="size-3.5" />
        </button>
      )}
    </SortableRow>
  )
}

export function GroupRow({
  group,
  count,
  onRename,
  onDelete,
  children,
}: {
  group: ProjectOrderGroup
  count: number
  onRename: (name: string) => void
  onDelete: () => void
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: group.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'rounded border border-border bg-muted/20',
        isDragging && 'opacity-50 z-10 relative',
        isOver && 'ring-1 ring-accent',
      )}
    >
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className={grip}
          title="Drag group"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
        <input
          aria-label="Group name"
          defaultValue={group.name}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 bg-transparent text-xs font-bold uppercase tracking-wider text-primary/80 outline-none border-b border-transparent focus:border-primary/40"
          onBlur={e => {
            const v = e.currentTarget.value.trim()
            if (v && v !== group.name) onRename(v)
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <span className="text-fg-faint text-[10px] tabular-nums">{count}</span>
        <button
          type="button"
          onClick={onDelete}
          className="text-fg-faint hover:text-destructive shrink-0"
          title="Delete group (projects return to ungrouped)"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div className="p-1.5 space-y-1 min-h-[2.25rem]">{children}</div>
    </div>
  )
}

export function UngroupedDropZone({ children }: { children: ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id: '__ungrouped__' })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded border border-dashed border-border p-1.5 space-y-1 min-h-[2.25rem]',
        isOver && 'border-accent bg-accent/10',
      )}
    >
      {children}
    </div>
  )
}
