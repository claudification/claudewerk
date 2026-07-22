/**
 * Right-click menus for a PROJECT row -- the normal one and the pinned variant.
 * They are the same menu; the normal one additionally offers the bulk cleanup
 * actions, so `ProjectMenuShell` holds the shared body and each export just
 * decides what (if anything) hangs off the end.
 *
 * Split out of conversation-context-menu.tsx, which had grown to hold three
 * separate menus.
 */

import { ContextMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { GroupingMenuItems } from './grouping-menu-items'
import { menuContentClass, menuItemClass, menuSeparatorClass } from './menu-shared'
import { ProjectMenuItems } from './project-menu-items'
import { terminateAllSummary } from './project-order-tree'
import { WorkspaceAssignSub } from './workspace-assign-menu'

function ProjectMenuShell({
  project,
  onOpenSettings,
  children,
  tail,
}: {
  project: string
  onOpenSettings: () => void
  children: ReactNode
  tail?: ReactNode
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContentClass}>
          <GroupingMenuItems project={project} />
          <WorkspaceAssignSub nodeId={project} />
          <ContextMenu.Separator className={menuSeparatorClass} />
          <ProjectMenuItems project={project} onOpenSettings={onOpenSettings} />
          {tail}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

export function PinnedProjectContextMenu(props: { project: string; onOpenSettings: () => void; children: ReactNode }) {
  return <ProjectMenuShell {...props} />
}

// Bulk "cleanup" fan-out: kill every running conversation and clear the
// already-ended ones, leaving the project empty. Each kill/dismiss is its own
// structured wire message (terminate_conversation / dismiss).
function terminateAllInProject(active: Conversation[], ended: Conversation[]) {
  if (!confirm(terminateAllSummary(active.length, ended.length))) return
  const store = useConversationsStore.getState()
  for (const s of active) store.terminateConversation(s.id, 'dashboard-terminate-project')
  for (const s of ended) store.dismissConversation(s.id)
}

function TerminateAllItem({ active, ended }: { active: Conversation[]; ended: Conversation[] }) {
  return (
    <ContextMenu.Item
      className={cn(menuItemClass, 'text-destructive')}
      onSelect={() => {
        haptic('error')
        terminateAllInProject(active, ended)
      }}
    >
      Terminate all ({active.length})…
    </ContextMenu.Item>
  )
}

function DismissEndedItem({ ended }: { ended: Conversation[] }) {
  const dismissConversation = useConversationsStore(s => s.dismissConversation)
  return (
    <ContextMenu.Item
      className={cn(menuItemClass, 'text-destructive')}
      onSelect={() => {
        haptic('tap')
        for (const s of ended) dismissConversation(s.id)
      }}
    >
      Dismiss {ended.length} ended
    </ContextMenu.Item>
  )
}

/** The destructive tail. The caller decides whether there is anything to act on,
 *  so this never has to render an orphan separator. */
function BulkItems({ active, ended }: { active: Conversation[]; ended: Conversation[] }) {
  return (
    <>
      <ContextMenu.Separator className={menuSeparatorClass} />
      {active.length > 0 && <TerminateAllItem active={active} ended={ended} />}
      {ended.length > 0 && <DismissEndedItem ended={ended} />}
    </>
  )
}

export function ProjectContextMenu({
  project,
  conversations,
  onOpenSettings,
  children,
}: {
  project: string
  conversations: Conversation[]
  onOpenSettings: () => void
  children: ReactNode
}) {
  const ended = conversations.filter(s => s.status === 'ended')
  const active = conversations.filter(s => s.status !== 'ended')
  const tail = conversations.length > 0 ? <BulkItems active={active} ended={ended} /> : undefined
  return (
    <ProjectMenuShell project={project} onOpenSettings={onOpenSettings} tail={tail}>
      {children}
    </ProjectMenuShell>
  )
}
