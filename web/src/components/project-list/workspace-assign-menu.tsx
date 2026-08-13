// The "Workspace" submenu on a project / group row.
//
// MEMBERSHIP IS MANY-TO-MANY and this menu says so: every workspace is a
// CHECKBOX, not a radio. It used to call a `projectInWorkspace()` helper that
// returned the FIRST workspace holding the project and highlighted only that
// one -- so a project living in three workspaces looked like it lived in one,
// and picking a second one silently read as "move".

import { Check } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOrder, Workspace } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { workspaceIdsForNode } from '@/lib/workspace-membership'
import { openManageWorkspaces } from '../manage-workspaces/manage-workspaces-state'
import { useWorkspaceActions } from './workspace-actions'
import { colorDot } from './workspace-colors'

const menuItemClass =
  'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

const EMPTY_WORKSPACES: Workspace[] = []

function useWorkspaceState(projectUri: string) {
  const workspaces = useConversationsStore(s => (s.projectOrder as ProjectOrder).workspaces ?? EMPTY_WORKSPACES)
  // Zustand selectors must not return fresh objects (React #185), so the Set is
  // collapsed to a stable sorted string and re-expanded here.
  const memberKey = useConversationsStore(s =>
    [...workspaceIdsForNode(s.projectOrder as ProjectOrder, projectUri)].sort().join(','),
  )
  const memberOf = new Set(memberKey ? memberKey.split(',') : [])
  return { workspaces, memberOf }
}

function WorkspaceListItems({ projectUri }: { projectUri: string }) {
  const { workspaces, memberOf } = useWorkspaceState(projectUri)
  const actions = useWorkspaceActions()
  return (
    <>
      {workspaces.map(ws => (
        <ContextMenu.Item
          key={ws.id}
          className={cn(menuItemClass, memberOf.has(ws.id) && 'text-primary')}
          // Keep the menu open: assigning to several workspaces in a row is the
          // normal case now, and a closing menu made that four round trips.
          onSelect={e => {
            e.preventDefault()
            haptic('tap')
            actions.toggleProject(projectUri, ws.id)
          }}
        >
          <span className="w-3.5 shrink-0">{memberOf.has(ws.id) && <Check className="size-3" />}</span>
          <span className={cn('size-2 rounded-full mr-2 shrink-0', colorDot(ws.color))} />
          {ws.name}
        </ContextMenu.Item>
      ))}
      {workspaces.length > 0 && <ContextMenu.Separator className="h-px bg-border my-1" />}
      {workspaces.length > 0 && (
        <ContextMenu.Item
          className={cn(menuItemClass, memberOf.size === 0 && 'text-primary')}
          onSelect={() => {
            haptic('tap')
            actions.removeFromAllWorkspaces(projectUri)
          }}
        >
          <span className="w-3.5 shrink-0" />
          None (All only)
        </ContextMenu.Item>
      )}
      <ContextMenu.Item
        className={menuItemClass}
        onSelect={() => {
          haptic('tap')
          openManageWorkspaces()
        }}
      >
        <span className="w-3.5 shrink-0" />
        Manage workspaces…
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
        <ContextMenu.SubContent className="min-w-[160px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
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
        <ContextMenu.Content className="min-w-[160px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          <WorkspaceListItems projectUri={groupId} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
