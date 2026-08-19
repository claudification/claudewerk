import { ContextMenu } from 'radix-ui'
import { useState } from 'react'
import { formatShortcut } from '@/lib/commands'
import type { Workspace } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { colorClasses, colorDot } from './workspace-colors'
import { positionalWorkspaceKey } from './workspace-hooks'
import { WorkspaceTabMenu } from './workspace-tab-menu'

export function InlineNameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  return (
    <input
      ref={el => el?.focus()}
      aria-label="Workspace name"
      defaultValue={initial}
      className="h-6 w-20 bg-background border border-border rounded px-1.5 text-[10px] font-mono outline-none focus:ring-1 focus:ring-primary"
      onKeyDown={e => {
        if (e.key === 'Enter') {
          const v = (e.target as HTMLInputElement).value.trim()
          if (v) onSubmit(v)
          else onCancel()
        }
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={e => {
        const v = e.target.value.trim()
        if (v && v !== initial) onSubmit(v)
        else onCancel()
      }}
    />
  )
}

/** A custom key always wins over the positional Ctrl+N slot -- so does its hint. */
function shortcutOf(ws: Workspace, index: number): string | null {
  return ws.key ?? positionalWorkspaceKey(index)
}

export function WorkspaceTabItem({
  ws,
  index,
  active,
  onSelect,
  onRename,
  onDelete,
  onRecolor,
  onManage,
}: {
  ws: Workspace
  index: number
  active: boolean
  onSelect: () => void
  onRename: (name: string) => void
  onDelete: () => void
  onRecolor: (color: string) => void
  onManage: () => void
}) {
  const [editing, setEditing] = useState(false)
  const cls = colorClasses[ws.color ?? '']
  const activeCls = active && cls ? `${cls.bg} ring-1 ${cls.ring}` : active ? 'bg-accent/20 ring-1 ring-accent/30' : ''
  const shortcut = shortcutOf(ws, index)

  if (editing) {
    return (
      <InlineNameInput
        initial={ws.name}
        onSubmit={name => {
          onRename(name)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          type="button"
          onClick={() => {
            haptic('tick')
            onSelect()
          }}
          onDoubleClick={() => setEditing(true)}
          title={shortcut ? `${ws.name} (${formatShortcut(shortcut)})` : ws.name}
          className={cn(
            'shrink-0 h-6 px-2.5 rounded-md text-[10px] font-mono transition-all cursor-pointer flex items-center gap-1.5',
            'hover:bg-accent/10 select-none',
            activeCls,
            !active && 'text-fg-dim hover:text-muted-foreground',
          )}
        >
          <span className={cn('size-1.5 rounded-full shrink-0', colorDot(ws.color))} />
          {ws.name}
          {shortcut && <span className="text-[8px] text-fg-faint">{formatShortcut(shortcut)}</span>}
        </button>
      </ContextMenu.Trigger>
      <WorkspaceTabMenu
        ws={ws}
        onRename={() => setEditing(true)}
        onDelete={onDelete}
        onRecolor={onRecolor}
        onManage={onManage}
      />
    </ContextMenu.Root>
  )
}
