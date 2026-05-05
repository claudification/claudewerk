import { extractProjectLabel } from '../../../shared/project-uri'
import type { Conversation, HookEventOf } from '../../../shared/protocol'
import { getProjectSettings } from '../../project-settings'
import type { ConversationStoreContext } from '../event-context'

/**
 * Notification hook: surface as a toast + raise the unread badge.
 * Title falls back to the project label when no friendly name is set.
 */
export function handleNotification(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  event: HookEventOf<'Notification'>,
): void {
  conv.hasNotification = true
  const message = typeof event.data.message === 'string' ? event.data.message : 'Needs attention'
  const projectName = getProjectSettings(conv.project)?.label || extractProjectLabel(conv.project)
  ctx.broadcastConversationScoped(
    {
      type: 'toast',
      conversationId,
      title: projectName,
      message,
    },
    conv.project,
  )
}
