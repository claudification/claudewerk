/**
 * The non-destructive half of a conversation's right-click menu: pin, open,
 * rename, recap, tasks, launch, links.
 *
 * Separated from the destructive tail (conversation-menu-danger.tsx) so the two
 * halves can be read on their own -- and so the separator between them means
 * something structural rather than decorative.
 */

import { projectIdentityKey } from '@shared/project-uri'
import { ContextMenu } from 'radix-ui'
import { updateProjectSettings, useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { usePinnedConversations } from '@/lib/conversation-pins'
import type { Conversation } from '@/lib/types'
import { projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { CanvasMenuItems } from '../canvas/canvas-menu-items'
import { RecapMenuItems } from '../recap-jobs/recap-menu-items'
import { openManageProjectLinks } from '../settings/manage-project-links-trigger'
import { openSpawnDialog } from '../spawn-dialog-trigger'
import { menuItemClass } from './menu-shared'

/** A plain menu row -- the shape nearly every entry here takes. */
function Item({
  label,
  onSelect,
  tone,
  haptics = 'tap',
}: {
  label: string
  onSelect: () => void
  tone?: string
  haptics?: 'tap' | 'error'
}) {
  return (
    <ContextMenu.Item
      className={tone ? cn(menuItemClass, tone) : menuItemClass}
      onSelect={() => {
        haptic(haptics)
        onSelect()
      }}
    >
      {label}
    </ContextMenu.Item>
  )
}

function markAllTasksDone(conversation: Conversation) {
  const msg =
    `Mark ${conversation.pendingTaskCount} pending task(s) as done?\n\n` +
    "This only updates the dashboard view. If the conversation reconnects, the agent host's task list will overwrite this."
  if (confirm(msg)) wsSend('mark_all_tasks_done', { conversationId: conversation.id })
}

/** Project-scoped rows that happen to hang off a conversation's menu. */
function ProjectRows({ project }: { project: string }) {
  const ps = useConversationsStore(s => s.projectSettings[projectIdentityKey(project)])
  return (
    <>
      <Item
        label="Launch new…"
        tone="text-cyan-400"
        onSelect={() => openSpawnDialog({ path: projectPath(project), projectUri: project })}
      />
      <Item label="Manage links…" onSelect={() => openManageProjectLinks(project)} />
      <Item
        label={ps?.pinned ? 'Unpin project' : 'Pin project'}
        onSelect={() => updateProjectSettings(project, { pinned: !ps?.pinned })}
      />
    </>
  )
}

export function ConversationMenuActions({
  conversation,
  onOpenSettings,
}: {
  conversation: Conversation
  onOpenSettings?: () => void
}) {
  const selectConversation = useConversationsStore(s => s.selectConversation)
  const isPinnedToSwitch = usePinnedConversations(s => s.pinnedIds.includes(conversation.id))
  const store = useConversationsStore.getState

  return (
    <>
      <Item
        label={isPinnedToSwitch ? 'Unpin from quick-switch' : 'Pin to quick-switch'}
        onSelect={() => usePinnedConversations.getState().togglePin(conversation.id)}
      />
      <Item
        label="Open in new window"
        onSelect={() => window.open(`/conversation/${conversation.id}`, `conv-${conversation.id}`, 'noopener')}
      />
      <Item label="Rename…" onSelect={() => store().setRenamingConversationId(conversation.id)} />
      <Item
        label="Edit description…"
        onSelect={() => store().setEditingDescriptionConversationId(conversation.id)}
      />
      {/* Conversation-level "old recap" (per-conversation away_summary) kept for
          now; the project-level period recap submenu follows. */}
      <Item
        label="Quick recap (this conversation)"
        onSelect={() => wsSend('recap_request', { conversationId: conversation.id })}
      />
      <RecapMenuItems projectUri={conversation.project} />
      <CanvasMenuItems projectUri={conversation.project} />
      {conversation.pendingTaskCount > 0 && (
        <Item label="Mark all tasks as done" onSelect={() => markAllTasksDone(conversation)} />
      )}
      {onOpenSettings && <Item label="Configuration…" onSelect={onOpenSettings} />}
      <Item
        label="Assign tasks…"
        tone="text-info"
        onSelect={() => {
          selectConversation(conversation.id)
          window.dispatchEvent(new Event('open-batch-selector'))
        }}
      />
      <ProjectRows project={conversation.project} />
    </>
  )
}
