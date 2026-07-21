/**
 * Right-click menu for a CONVERSATION row.
 *
 * This file is now just the shell: grouping + workspace at the top, the action
 * items, then the destructive tail. The three menus that used to share this file
 * (project + pinned-project) moved to project-context-menu.tsx.
 */

import { ContextMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import type { Conversation } from '@/lib/types'
import { ConversationMenuActions } from './conversation-menu-actions'
import { ConversationMenuDanger } from './conversation-menu-danger'
import { GroupingMenuItems } from './grouping-menu-items'
import { menuContentClass } from './menu-shared'
import { WorkspaceAssignSub } from './workspace-assign-menu'

export function ConversationContextMenu({
  conversation,
  onOpenSettings,
  children,
}: {
  conversation: Conversation
  onOpenSettings?: () => void
  children: ReactNode
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContentClass}>
          <GroupingMenuItems project={conversation.project} />
          <WorkspaceAssignSub nodeId={conversation.project} />
          <ConversationMenuActions conversation={conversation} onOpenSettings={onOpenSettings} />
          <ConversationMenuDanger conversation={conversation} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
