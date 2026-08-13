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
import { useEndedIdsForProject } from './row-hooks'
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
function terminateAllInProject(active: Conversation[], endedIds: string[]) {
  if (!confirm(terminateAllSummary(active.length, endedIds.length))) return
  const store = useConversationsStore.getState()
  for (const s of active) store.terminateConversation(s.id, 'dashboard-terminate-project')
  for (const id of endedIds) store.dismissConversation(id)
}

function TerminateAllItem({ active, endedIds }: { active: Conversation[]; endedIds: string[] }) {
  return (
    <ContextMenu.Item
      className={cn(menuItemClass, 'text-destructive')}
      onSelect={() => {
        haptic('error')
        terminateAllInProject(active, endedIds)
      }}
    >
      Terminate all ({active.length})…
    </ContextMenu.Item>
  )
}

/** The ONLY remaining purge path for a project's ended conversations. The project
 *  header used to carry an inline "✕ ended" button; it was removed because the
 *  header must not advertise ended conversations at all. Right-click still reaches
 *  this -- without it thousands of ended conversations pile up unclearable. */
function DismissEndedItem({ endedIds }: { endedIds: string[] }) {
  const dismissConversation = useConversationsStore(s => s.dismissConversation)
  return (
    <ContextMenu.Item
      className={cn(menuItemClass, 'text-destructive')}
      onSelect={() => {
        haptic('tap')
        for (const id of endedIds) dismissConversation(id)
      }}
    >
      Dismiss {endedIds.length} ended
    </ContextMenu.Item>
  )
}

/** The destructive tail. The caller decides whether there is anything to act on,
 *  so this never has to render an orphan separator. */
function BulkItems({ active, endedIds }: { active: Conversation[]; endedIds: string[] }) {
  return (
    <>
      <ContextMenu.Separator className={menuSeparatorClass} />
      {active.length > 0 && <TerminateAllItem active={active} endedIds={endedIds} />}
      {endedIds.length > 0 && <DismissEndedItem endedIds={endedIds} />}
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
  // `conversations` are the rendered rows, which by construction never include an
  // ended one -- the ended set has to come from the store or "dismiss ended"
  // would silently have nothing to do.
  const endedIds = useEndedIdsForProject(project)
  const active = conversations.filter(s => s.status !== 'ended')
  const tail = active.length + endedIds.length > 0 ? <BulkItems active={active} endedIds={endedIds} /> : undefined
  return (
    <ProjectMenuShell project={project} onOpenSettings={onOpenSettings} tail={tail}>
      {children}
    </ProjectMenuShell>
  )
}
