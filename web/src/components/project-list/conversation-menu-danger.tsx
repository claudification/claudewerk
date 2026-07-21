/**
 * The destructive tail of a conversation's right-click menu: respawn, terminate,
 * terminate-lineage, and the revive/dismiss pair for an ended conversation.
 *
 * Every entry here is gated on conversation state, so which rows exist at all
 * depends on status -- keeping them together makes that reachability readable
 * instead of scattered through 200 lines of menu.
 */

import { ContextMenu } from 'radix-ui'
import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { canRespawnStaleDaemon } from '@/lib/daemon-control'
import { selectConversations } from '@/lib/slim-conversation'
import type { Conversation } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { openReviveDialog } from '../revive-dialog-trigger'
import { openTerminateLineageConfirm } from '../terminate-lineage-confirm-trigger'
import { menuItemClass, menuSeparatorClass } from './menu-shared'

function DangerItem({
  label,
  onSelect,
  tone = 'text-destructive',
  haptics = 'error',
}: {
  label: string
  onSelect: () => void
  tone?: string
  haptics?: 'tap' | 'error'
}) {
  return (
    <ContextMenu.Item
      className={cn(menuItemClass, tone)}
      onSelect={() => {
        haptic(haptics)
        onSelect()
      }}
    >
      {label}
    </ContextMenu.Item>
  )
}

/** Revive + dismiss, the pair that only exists once a conversation has ended. */
function EndedItems({ conversationId }: { conversationId: string }) {
  const dismissConversation = useConversationsStore(s => s.dismissConversation)
  const selectConversation = useConversationsStore(s => s.selectConversation)
  return (
    <>
      <DangerItem
        label="Revive…"
        tone="text-emerald-400"
        haptics="tap"
        onSelect={() => {
          selectConversation(conversationId)
          openReviveDialog({ conversationId })
        }}
      />
      <DangerItem label="Dismiss" haptics="tap" onSelect={() => dismissConversation(conversationId)} />
    </>
  )
}

export function ConversationMenuDanger({ conversation }: { conversation: Conversation }) {
  // Has at least one spawned descendant -> offer "Terminate full lineage".
  // Independent of this conversation's own status: a spawn root can be ended
  // while its children are still live (the common chain case).
  const hasLineageChildren = useConversationsStore(s =>
    selectConversations(s.conversationsById).some(c => c.parentConversationId === conversation.id),
  )
  const ended = conversation.status === 'ended'

  return (
    <>
      <ContextMenu.Separator className={menuSeparatorClass} />
      {canRespawnStaleDaemon(conversation) && (
        <DangerItem
          label="Respawn stale worker"
          tone="text-sky-400"
          haptics="tap"
          onSelect={() => wsSend('daemon_respawn_stale', { conversationId: conversation.id })}
        />
      )}
      {ended ? (
        <EndedItems conversationId={conversation.id} />
      ) : (
        <DangerItem
          label="Terminate conversation"
          onSelect={() =>
            useConversationsStore.getState().terminateConversation(conversation.id, 'dashboard-context-menu')
          }
        />
      )}
      {hasLineageChildren && (
        <DangerItem label="Terminate full lineage…" onSelect={() => openTerminateLineageConfirm(conversation.id)} />
      )}
    </>
  )
}
