import { ContextMenu } from 'radix-ui'
import { useRef, useState } from 'react'
import type { Workspace } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { colorClasses, colorDot, WORKSPACE_COLORS } from './workspace-hooks'

const menuItemClass =
  'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

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
      className="h-5 w-20 bg-background border border-border rounded px-1 text-[10px] font-mono outline-none focus:ring-1 focus:ring-primary"
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

// fallow-ignore-next-line complexity
export function WorkspaceTabItem({
  ws,
  active,
  onSelect,
  onRename,
  onDelete,
  onRecolor,
}: {
  ws: Workspace
  active: boolean
  onSelect: () => void
  onRename: (name: string) => void
  onDelete: () => void
  onRecolor: (color: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const cls = colorClasses[ws.color ?? '']
  const activeCls = active && cls ? `${cls.bg} ring-1 ${cls.ring}` : active ? 'bg-accent/20 ring-1 ring-accent/30' : ''

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
          className={cn(
            'shrink-0 h-5 px-2 rounded text-[10px] font-mono transition-all cursor-pointer flex items-center gap-1',
            'hover:bg-accent/10 select-none',
            activeCls,
            !active && 'text-muted-foreground/60 hover:text-muted-foreground',
          )}
        >
          <span className={cn('size-1.5 rounded-full shrink-0', colorDot(ws.color))} />
          {ws.name}
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[140px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          <ContextMenu.Item className={menuItemClass} onSelect={() => setEditing(true)}>
            Rename…
          </ContextMenu.Item>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className={menuItemClass}>
              Color <span className="ml-auto text-muted-foreground">{'▸'}</span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="min-w-[120px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
                {WORKSPACE_COLORS.map(c => (
                  <ContextMenu.Item
                    key={c}
                    className={cn(menuItemClass, ws.color === c && 'text-primary')}
                    onSelect={() => onRecolor(c)}
                  >
                    <span className={cn('size-2 rounded-full mr-2', colorDot(c))} />
                    {c}
                  </ContextMenu.Item>
                ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Separator className="h-px bg-border my-1" />
          <ContextMenu.Item className={cn(menuItemClass, 'text-destructive')} onSelect={onDelete}>
            Delete workspace
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
