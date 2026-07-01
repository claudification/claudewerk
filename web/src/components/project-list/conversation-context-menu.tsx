import { projectIdentityKey } from '@shared/project-uri'
import { ContextMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { saveProjectOrder, updateProjectSettings, useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { openNightshiftModal } from '@/hooks/use-nightshift-modal'
import { usePinnedConversations } from '@/lib/conversation-pins'
import { canRespawnStaleDaemon } from '@/lib/daemon-control'
import { selectConversations } from '@/lib/slim-conversation'
import type { Conversation, ProjectOrder, ProjectOrderGroup } from '@/lib/types'
import { projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { RecapMenuItems } from '../recap-jobs/recap-menu-items'
import { openReviveDialog } from '../revive-dialog-trigger'
import { openManageProjectLinks } from '../settings/manage-project-links-trigger'
import { openSpawnDialog } from '../spawn-dialog-trigger'
import { openTerminateLineageConfirm } from '../terminate-lineage-confirm-trigger'
import { WorkspaceAssignSub } from './workspace-assign-menu'

// ─── Conversation context menu (right-click) ─────────────────────────────

const menuItemClass =
  'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

// Grouping actions that operate on a project key (shared by conversation + project menus).
function useProjectGroupingActions(project: string) {
  const rawProjectOrder = useConversationsStore(s => s.projectOrder) as ProjectOrder | null
  const projectOrder = rawProjectOrder?.tree ? rawProjectOrder : { tree: [] }
  const groups = projectOrder.tree.filter((n): n is ProjectOrderGroup => n.type === 'group')

  function moveToGroup(groupId: string) {
    haptic('tap')
    const newTree = projectOrder.tree.map(node => {
      if (node.type === 'group') {
        const filtered = { ...node, children: node.children.filter(c => c.id !== project) }
        if (node.id === groupId) {
          return { ...filtered, children: [...filtered.children, { id: project, type: 'project' as const }] }
        }
        return filtered
      }
      return node
    })
    const rootFiltered = newTree.filter(n => n.id !== project)
    saveProjectOrder({ tree: rootFiltered })
  }

  function removeFromGroups() {
    haptic('tap')
    const newTree = projectOrder.tree.map(node => {
      if (node.type === 'group') {
        return { ...node, children: node.children.filter(c => c.id !== project) }
      }
      return node
    })
    if (!newTree.some(n => n.id === project)) {
      newTree.push({ id: project, type: 'project' as const })
    }
    saveProjectOrder({ tree: newTree })
  }

  function createGroupAndMove() {
    const name = prompt('Group name:')
    if (!name?.trim()) return
    haptic('tap')
    const groupId = `group-${name.trim().toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`
    let newTree: typeof projectOrder.tree = []
    for (const node of projectOrder.tree) {
      if (node.id === project) continue
      if (node.type === 'group') {
        newTree.push({ ...node, children: node.children.filter(c => c.id !== project) })
      } else {
        newTree.push(node)
      }
    }
    newTree = [
      ...newTree,
      {
        id: groupId,
        type: 'group' as const,
        name: name.trim(),
        children: [{ id: project, type: 'project' as const }],
      },
    ]
    saveProjectOrder({ tree: newTree })
  }

  return { groups, moveToGroup, removeFromGroups, createGroupAndMove }
}

function GroupingMenuItems({ project }: { project: string }) {
  const { groups, moveToGroup, removeFromGroups, createGroupAndMove } = useProjectGroupingActions(project)
  return (
    <>
      {groups.length > 0 && (
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger className={menuItemClass}>
            Move to <span className="ml-auto text-muted-foreground">{'\u25B8'}</span>
          </ContextMenu.SubTrigger>
          <ContextMenu.Portal>
            <ContextMenu.SubContent className="min-w-[160px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
              {groups.map(g => (
                <ContextMenu.Item key={g.id} className={menuItemClass} onSelect={() => moveToGroup(g.id)}>
                  {g.name}
                </ContextMenu.Item>
              ))}
              <ContextMenu.Separator className="h-px bg-border my-1" />
              <ContextMenu.Item className={menuItemClass} onSelect={removeFromGroups}>
                Unpin (no group)
              </ContextMenu.Item>
            </ContextMenu.SubContent>
          </ContextMenu.Portal>
        </ContextMenu.Sub>
      )}
      <ContextMenu.Item className={menuItemClass} onSelect={createGroupAndMove}>
        New group…
      </ContextMenu.Item>
    </>
  )
}

export function ConversationContextMenu({
  conversation,
  onOpenSettings,
  children,
}: {
  conversation: Conversation
  onOpenSettings?: () => void
  children: ReactNode
}) {
  const dismissConversation = useConversationsStore(s => s.dismissConversation)
  const selectConversation = useConversationsStore(s => s.selectConversation)
  const ps = useConversationsStore(s => s.projectSettings[projectIdentityKey(conversation.project)])
  const isPinnedToSwitch = usePinnedConversations(s => s.pinnedIds.includes(conversation.id))
  // Has at least one spawned descendant -> offer "Terminate full lineage".
  // Independent of this conversation's own status: a spawn root can be ended
  // while its children are still live (the common chain case).
  const hasLineageChildren = useConversationsStore(s =>
    selectConversations(s.conversationsById).some(c => c.parentConversationId === conversation.id),
  )

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[180px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          <GroupingMenuItems project={conversation.project} />
          <WorkspaceAssignSub nodeId={conversation.project} />
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              usePinnedConversations.getState().togglePin(conversation.id)
            }}
          >
            {isPinnedToSwitch ? 'Unpin from quick-switch' : 'Pin to quick-switch'}
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              window.open(`/conversation/${conversation.id}`, `conv-${conversation.id}`, 'noopener')
            }}
          >
            Open in new window
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              useConversationsStore.getState().setRenamingConversationId(conversation.id)
            }}
          >
            Rename…
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              useConversationsStore.getState().setEditingDescriptionConversationId(conversation.id)
            }}
          >
            Edit description…
          </ContextMenu.Item>
          {/* Conversation-level "old recap" (per-conversation away_summary)
              kept for now; the new project-level period recap submenu lives
              below. wsSend('recap_request') is the legacy 20-word summary. */}
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              wsSend('recap_request', { conversationId: conversation.id })
            }}
          >
            Quick recap (this conversation)
          </ContextMenu.Item>
          <RecapMenuItems projectUri={conversation.project} />
          {conversation.pendingTaskCount > 0 && (
            <ContextMenu.Item
              className={menuItemClass}
              onSelect={() => {
                haptic('tap')
                if (
                  confirm(
                    `Mark ${conversation.pendingTaskCount} pending task(s) as done?\n\nThis only updates the dashboard view. If the conversation reconnects, the agent host's task list will overwrite this.`,
                  )
                ) {
                  wsSend('mark_all_tasks_done', { conversationId: conversation.id })
                }
              }}
            >
              Mark all tasks as done
            </ContextMenu.Item>
          )}
          {onOpenSettings && (
            <ContextMenu.Item
              className={menuItemClass}
              onSelect={() => {
                haptic('tap')
                onOpenSettings()
              }}
            >
              Configuration…
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            className={cn(menuItemClass, 'text-cyan-400')}
            onSelect={() => {
              haptic('tap')
              openSpawnDialog({ path: projectPath(conversation.project), projectUri: conversation.project })
            }}
          >
            Launch new…
          </ContextMenu.Item>
          <ContextMenu.Item
            className={cn(menuItemClass, 'text-info')}
            onSelect={() => {
              haptic('tap')
              selectConversation(conversation.id)
              window.dispatchEvent(new Event('open-batch-selector'))
            }}
          >
            Assign tasks…
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              openManageProjectLinks(conversation.project)
            }}
          >
            Manage links…
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              haptic('tap')
              updateProjectSettings(conversation.project, { pinned: !ps?.pinned })
            }}
          >
            {ps?.pinned ? 'Unpin project' : 'Pin project'}
          </ContextMenu.Item>
          <ContextMenu.Separator className="h-px bg-border my-1" />
          {canRespawnStaleDaemon(conversation) && (
            <ContextMenu.Item
              className={cn(menuItemClass, 'text-sky-400')}
              onSelect={() => {
                haptic('tap')
                wsSend('daemon_respawn_stale', { conversationId: conversation.id })
              }}
            >
              Respawn stale worker
            </ContextMenu.Item>
          )}
          {conversation.status !== 'ended' && (
            <ContextMenu.Item
              className={cn(menuItemClass, 'text-destructive')}
              onSelect={() => {
                haptic('error')
                useConversationsStore.getState().terminateConversation(conversation.id, 'dashboard-context-menu')
              }}
            >
              Terminate conversation
            </ContextMenu.Item>
          )}
          {hasLineageChildren && (
            <ContextMenu.Item
              className={cn(menuItemClass, 'text-destructive')}
              onSelect={() => {
                haptic('error')
                openTerminateLineageConfirm(conversation.id)
              }}
            >
              Terminate full lineage…
            </ContextMenu.Item>
          )}
          {conversation.status === 'ended' && (
            <>
              <ContextMenu.Item
                className={cn(menuItemClass, 'text-emerald-400')}
                onSelect={() => {
                  haptic('tap')
                  selectConversation(conversation.id)
                  openReviveDialog({ conversationId: conversation.id })
                }}
              >
                Revive…
              </ContextMenu.Item>
              <ContextMenu.Item
                className={cn(menuItemClass, 'text-destructive')}
                onSelect={() => {
                  haptic('tap')
                  dismissConversation(conversation.id)
                }}
              >
                Dismiss
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

function ProjectMenuItems({ project, onOpenSettings }: { project: string; onOpenSettings: () => void }) {
  const ps = useConversationsStore(s => s.projectSettings[projectIdentityKey(project)])
  return (
    <>
      <ContextMenu.Item
        className={cn(menuItemClass, 'text-cyan-400')}
        onSelect={() => {
          haptic('tap')
          openSpawnDialog({ path: projectPath(project), projectUri: project })
        }}
      >
        Launch new…
      </ContextMenu.Item>
      <RecapMenuItems projectUri={project} />
      <ContextMenu.Item
        className={cn(menuItemClass, 'text-amber-400')}
        onSelect={() => {
          haptic('tap')
          openNightshiftModal(project, 'outlook')
        }}
      >
        Nightshift…
      </ContextMenu.Item>
      <ContextMenu.Item
        className={menuItemClass}
        onSelect={() => {
          haptic('tap')
          onOpenSettings()
        }}
      >
        Project settings…
      </ContextMenu.Item>
      <ContextMenu.Item
        className={menuItemClass}
        onSelect={() => {
          haptic('tap')
          openManageProjectLinks(project)
        }}
      >
        Manage links…
      </ContextMenu.Item>
      <ContextMenu.Item
        className={menuItemClass}
        onSelect={() => {
          haptic('tap')
          updateProjectSettings(project, { pinned: !ps?.pinned })
        }}
      >
        {ps?.pinned ? 'Unpin project' : 'Pin project'}
      </ContextMenu.Item>
    </>
  )
}

export function PinnedProjectContextMenu({
  project,
  onOpenSettings,
  children,
}: {
  project: string
  onOpenSettings: () => void
  children: ReactNode
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[180px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          <GroupingMenuItems project={project} />
          <WorkspaceAssignSub nodeId={project} />
          <ContextMenu.Separator className="h-px bg-border my-1" />
          <ProjectMenuItems project={project} onOpenSettings={onOpenSettings} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

// Bulk "cleanup" fan-out for the project menu: kill every running conversation
// and clear the already-ended ones, leaving the project empty. Each kill/dismiss
// is its own structured wire message (terminate_conversation / dismiss).
function terminateAllInProject(active: Conversation[], ended: Conversation[]) {
  const summary =
    `Terminate ALL ${active.length} running conversation(s) in this project?` +
    (ended.length > 0 ? `\n\nAlso dismisses ${ended.length} ended conversation(s).` : '') +
    '\n\nRunning agents will be killed. This cannot be undone.'
  if (!confirm(summary)) return
  const store = useConversationsStore.getState()
  for (const s of active) store.terminateConversation(s.id, 'dashboard-terminate-project')
  for (const s of ended) store.dismissConversation(s.id)
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
  const dismissConversation = useConversationsStore(s => s.dismissConversation)
  const ended = conversations.filter(s => s.status === 'ended')
  const active = conversations.filter(s => s.status !== 'ended')

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[180px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          <GroupingMenuItems project={project} />
          <WorkspaceAssignSub nodeId={project} />
          <ContextMenu.Separator className="h-px bg-border my-1" />
          <ProjectMenuItems project={project} onOpenSettings={onOpenSettings} />
          {(active.length > 0 || ended.length > 0) && <ContextMenu.Separator className="h-px bg-border my-1" />}
          {active.length > 0 && (
            <ContextMenu.Item
              className={cn(menuItemClass, 'text-destructive')}
              onSelect={() => {
                haptic('error')
                terminateAllInProject(active, ended)
              }}
            >
              Terminate all ({active.length})…
            </ContextMenu.Item>
          )}
          {ended.length > 0 && (
            <ContextMenu.Item
              className={cn(menuItemClass, 'text-destructive')}
              onSelect={() => {
                haptic('tap')
                for (const s of ended) dismissConversation(s.id)
              }}
            >
              Dismiss {ended.length} ended
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
