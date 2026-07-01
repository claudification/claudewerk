import { ContextMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOrder, Workspace } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { colorDot, useWorkspaceActions } from './workspace-hooks'

const menuItemClass =
  'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

const EMPTY_WORKSPACES: Workspace[] = []

// fallow-ignore-next-line complexity
function findRootNodeId(tree: ProjectOrder['tree'], nodeId: string): string {
  for (const n of tree) {
    if (n.id === nodeId) return n.id
    if (n.type === 'group' && n.children.some(c => c.id === nodeId)) return n.id
  }
  return nodeId
}

function useWorkspaceAssignment(nodeId: string) {
  const workspaces = useConversationsStore(s => (s.projectOrder as ProjectOrder).workspaces ?? EMPTY_WORKSPACES)
  const rootId = useConversationsStore(s => findRootNodeId((s.projectOrder as ProjectOrder).tree ?? [], nodeId))
  const currentWsId = useConversationsStore(s => ((s.projectOrder as ProjectOrder).assignments ?? {})[rootId] ?? null)
  return { workspaces, currentWsId, rootId }
}

function WorkspaceListItems({ nodeId }: { nodeId: string }) {
  const { workspaces, currentWsId, rootId } = useWorkspaceAssignment(nodeId)
  const actions = useWorkspaceActions()
  return (
    <>
      {workspaces.map(ws => (
        <ContextMenu.Item
          key={ws.id}
          className={cn(menuItemClass, currentWsId === ws.id && 'text-primary')}
          onSelect={() => {
            haptic('tap')
            actions.assign(rootId, ws.id)
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
            actions.assign(rootId, null)
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
          actions.createAndAssign(name.trim(), workspaces.length, rootId)
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
          <WorkspaceListItems nodeId={nodeId} />
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
          <WorkspaceListItems nodeId={groupId} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
