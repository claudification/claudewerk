import { useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOrder } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { useWorkspaceActions } from './workspace-hooks'
import { InlineNameInput, WorkspaceTabItem } from './workspace-tab-item'

// fallow-ignore-next-line complexity
export function WorkspaceTabs() {
  const projectOrder = useConversationsStore(s => s.projectOrder) as ProjectOrder
  const activeId = useConversationsStore(s => s.controlPanelPrefs.activeWorkspaceId)
  const [creating, setCreating] = useState(false)
  const actions = useWorkspaceActions()

  const workspaces = projectOrder.workspaces ?? []

  return (
    <div className="flex items-center gap-0.5 px-1 pb-1.5 overflow-x-auto scrollbar-none">
      {workspaces.length > 0 && (
        <button
          type="button"
          onClick={() => {
            haptic('tick')
            actions.setActive(null)
          }}
          title="All (Ctrl+1)"
          className={cn(
            'shrink-0 h-5 px-2 rounded text-[10px] font-mono transition-all cursor-pointer flex items-center gap-1',
            'hover:bg-accent/10 select-none',
            activeId === null
              ? 'bg-accent/20 ring-1 ring-accent/30 text-foreground'
              : 'text-muted-foreground/60 hover:text-muted-foreground',
          )}
        >
          All
          <span className="text-[8px] text-muted-foreground/40">^1</span>
        </button>
      )}
      {workspaces.map((ws, i) => (
        <WorkspaceTabItem
          key={ws.id}
          ws={ws}
          shortcutIndex={i + 2}
          active={activeId === ws.id}
          onSelect={() => actions.setActive(ws.id)}
          onRename={name => actions.rename(ws.id, name)}
          onDelete={() => actions.remove(ws.id, activeId)}
          onRecolor={color => actions.recolor(ws.id, color)}
        />
      ))}
      {creating ? (
        <InlineNameInput
          initial=""
          onSubmit={name => {
            actions.create(name, workspaces.length)
            setCreating(false)
          }}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            haptic('tick')
            setCreating(true)
          }}
          className="shrink-0 h-5 px-1.5 rounded text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent/10 transition-all cursor-pointer select-none"
          title="New workspace"
        >
          +
        </button>
      )}
    </div>
  )
}
