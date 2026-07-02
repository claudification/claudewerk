import { ContextMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOrder, ProjectOrderNode, Workspace } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { colorDot, useWorkspaceActions } from './workspace-hooks'

const menuItemClass =
  'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

const EMPTY_WORKSPACES: Workspace[] = []

function projectInWorkspace(trees: Record<string, ProjectOrderNode[]>, projectUri: string): string | null {
  for (const [wsId, wsTree] of Object.entries(trees)) {
    if (wsTree.some(n => n.id === projectUri)) return wsId
  }
  return null
}

function useWorkspaceState(projectUri: string) {
  const workspaces = useConversationsStore(s => (s.projectOrder as ProjectOrder).workspaces ?? EMPTY_WORKSPACES)
  const currentWsId = useConversationsStore(s =>
    projectInWorkspace((s.projectOrder as ProjectOrder).workspaceTrees ?? {}, projectUri),
  )
  return { workspaces, currentWsId }
}

function WorkspaceListItems({ projectUri }: { projectUri: string }) {
  const { workspaces, currentWsId } = useWorkspaceState(projectUri)
  const actions = useWorkspaceActions()
  return (
    <>
      {workspaces.map(ws => (
        <ContextMenu.Item
          key={ws.id}
          className={cn(menuItemClass, currentWsId === ws.id && 'text-primary')}
          onSelect={() => {
            haptic('tap')
            actions.assignProject(projectUri, ws.id)
          }}
        >
          <span className={cn('size-2 rounded-full mr-2 shrink-0', colorDot(ws.color))} />
          {ws.name}
        </ContextMenu.Item>
      ))}
      {workspaces.length > 0 && <ContextMenu.Separator className="h-px bg-border my-1" />}
      {workspaces.length > 0 && (
        <ContextMenu.Item
          className={cn(menuItemClass, !currentWsId && 'text-primary')}
          onSelect={() => {
            haptic('tap')
            actions.removeFromAllWorkspaces(projectUri)
          }}
        >
          None (All only)
        </ContextMenu.Item>
      )}
      <ContextMenu.Item
        className={menuItemClass}
        onSelect={() => {
          haptic('tap')
          const name = prompt('Workspace name:')
          if (!name?.trim()) return
          actions.createAndAssign(name.trim(), workspaces.length, projectUri)
        }}
      >
        New workspace…
      </ContextMenu.Item>
    </>
  )
}

export function WorkspaceAssignSub({ nodeId }: { nodeId: string }) {
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={menuItemClass}>
        Workspace <span className="ml-auto text-muted-foreground">{'▸'}</span>
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className="min-w-[140px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          <WorkspaceListItems projectUri={nodeId} />
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  )
}

export function GroupContextMenu({ groupId, children }: { groupId: string; children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[140px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          <WorkspaceListItems projectUri={groupId} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
