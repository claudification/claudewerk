/** Left pane: the workspace list itself -- drag to reorder, rename inline, set a
 *  colour, assign a custom key, delete. Selecting one drives the right pane. */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import type { Workspace } from '@/lib/types'
import { cn } from '@/lib/utils'
import { colorDot, WORKSPACE_COLORS } from '../project-list/workspace-colors'
import { positionalWorkspaceKey } from '../project-list/workspace-hooks'
import { WorkspaceKeyEditor } from './workspace-key-editor'

const grip = 'cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-foreground touch-none shrink-0'

function ColorPicker({ value, onPick }: { value: string | undefined; onPick: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1">
      {WORKSPACE_COLORS.map(c => (
        <button
          key={c}
          type="button"
          title={c}
          onClick={() => onPick(c)}
          className={cn(
            'size-2.5 rounded-full transition-transform hover:scale-125',
            colorDot(c),
            value === c ? 'ring-1 ring-offset-1 ring-offset-background ring-foreground/60' : 'opacity-50',
          )}
        />
      ))}
    </div>
  )
}

export interface WorkspaceRowActions {
  onSelect: () => void
  onRename: (name: string) => void
  onRecolor: (color: string) => void
  onSetKey: (key: string | null) => void
  onDelete: () => void
}

export function WorkspaceRow({
  ws,
  index,
  memberCount,
  selected,
  otherKeys,
  actions,
}: {
  ws: Workspace
  index: number
  memberCount: number
  selected: boolean
  otherKeys: string[]
  actions: WorkspaceRowActions
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: ws.id,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'rounded border bg-background px-2 py-1.5 space-y-1.5',
        selected ? 'border-primary/60 bg-primary/5' : 'border-border/60',
        isDragging && 'opacity-40 z-10 relative',
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className={grip}
          title="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
        <span className={cn('size-2 rounded-full shrink-0', colorDot(ws.color))} />
        <input
          aria-label="Workspace name"
          defaultValue={ws.name}
          autoComplete="off"
          spellCheck={false}
          onFocus={actions.onSelect}
          className="flex-1 min-w-0 bg-transparent text-xs font-mono outline-none border-b border-transparent focus:border-primary/40"
          onBlur={e => {
            const v = e.currentTarget.value.trim()
            if (v && v !== ws.name) actions.onRename(v)
            else e.currentTarget.value = ws.name
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <button
          type="button"
          onClick={actions.onSelect}
          title="Show this workspace's projects"
          className={cn(
            'text-[10px] tabular-nums px-1.5 py-0.5 rounded',
            selected ? 'text-primary' : 'text-muted-foreground/50 hover:text-foreground',
          )}
        >
          {memberCount}
        </button>
        <button
          type="button"
          onClick={actions.onDelete}
          className="text-muted-foreground/40 hover:text-destructive shrink-0"
          title="Delete workspace (projects are untouched)"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 pl-6">
        <ColorPicker value={ws.color} onPick={actions.onRecolor} />
        <WorkspaceKeyEditor
          fallback={positionalWorkspaceKey(index)}
          custom={ws.key}
          otherKeys={otherKeys}
          onChange={actions.onSetKey}
        />
      </div>
    </div>
  )
}

export function AddWorkspaceRow({ onAdd }: { onAdd: (name: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        const name = window.prompt('Workspace name')?.trim()
        if (name) onAdd(name)
      }}
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground px-1 py-1"
    >
      <Plus className="size-3.5" /> New workspace
    </button>
  )
}
