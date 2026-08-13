import { Settings2 } from 'lucide-react'
import { useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOrder } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { openManageWorkspaces } from '../manage-workspaces/manage-workspaces-state'
import { useWorkspaceActions } from './workspace-actions'
import { InlineNameInput, WorkspaceTabItem } from './workspace-tab-item'

const stripButton =
  'shrink-0 size-6 grid place-items-center rounded text-muted-foreground/50 hover:text-foreground hover:bg-accent/10 transition-colors cursor-pointer select-none'

export function WorkspaceTabs() {
  const projectOrder = useConversationsStore(s => s.projectOrder) as ProjectOrder
  const activeId = useConversationsStore(s => s.controlPanelPrefs.activeWorkspaceId)
  const [creating, setCreating] = useState(false)
  const actions = useWorkspaceActions()

  const workspaces = projectOrder.workspaces ?? []

  return (
    // Symmetric px-2 with py-1.5 top AND bottom: the strip used to sit flush
    // against the sidebar chrome with padding on one side only, which read as a
    // rendering glitch rather than a row of tabs.
    <div className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto scrollbar-none">
      {workspaces.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => {
              haptic('tick')
              actions.setActive(null)
            }}
            title="All (Ctrl+1)"
            className={cn(
              'shrink-0 h-6 px-2.5 rounded-md text-[10px] font-mono transition-all cursor-pointer flex items-center gap-1.5',
              'hover:bg-accent/10 select-none',
              activeId === null
                ? 'bg-accent/20 ring-1 ring-accent/30 text-foreground'
                : 'text-muted-foreground/60 hover:text-muted-foreground',
            )}
          >
            All
            <span className="text-[8px] text-muted-foreground/40">^1</span>
          </button>
          <span className="shrink-0 w-px h-3.5 bg-border/60 mx-0.5" />
        </>
      )}
      {workspaces.map((ws, i) => (
        <WorkspaceTabItem
          key={ws.id}
          ws={ws}
          index={i}
          active={activeId === ws.id}
          onSelect={() => actions.setActive(ws.id)}
          onRename={name => actions.rename(ws.id, name)}
          onDelete={() => actions.remove(ws.id, activeId)}
          onRecolor={color => actions.recolor(ws.id, color)}
          onManage={openManageWorkspaces}
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
          className={cn(stripButton, 'text-xs leading-none')}
          title="New workspace"
        >
          +
        </button>
      )}
      {workspaces.length > 0 && (
        <button
          type="button"
          onClick={() => {
            haptic('tick')
            openManageWorkspaces()
          }}
          className={stripButton}
          title="Manage workspaces"
        >
          <Settings2 className="size-3" />
        </button>
      )}
    </div>
  )
}
