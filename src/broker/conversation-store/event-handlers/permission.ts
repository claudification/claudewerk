import { extractProjectLabel } from '../../../shared/project-uri'
import type { Conversation, HookEventOf } from '../../../shared/protocol'
import { getProjectSettings } from '../../project-settings'
import type { ConversationStoreContext } from '../event-context'

/**
 * PermissionRequest: Claude is blocked waiting for permission approval.
 */
export function handlePermissionRequest(session: Conversation, event: HookEventOf<'PermissionRequest'>): void {
  const data = event.data
  const filePath = data.tool_input?.file_path
  session.pendingAttention = {
    type: 'permission',
    toolName: data.tool_name,
    filePath: typeof filePath === 'string' ? filePath : undefined,
    timestamp: event.timestamp,
  }
}

/**
 * PermissionDenied: tool was blocked by user rules. Clear pending state +
 * surface a toast so the user knows what happened.
 */
export function handlePermissionDenied(
  ctx: ConversationStoreContext,
  conversationId: string,
  session: Conversation,
  event: HookEventOf<'PermissionDenied'>,
): void {
  if (session.pendingAttention?.type === 'permission') {
    session.pendingAttention = undefined
  }
  if (session.pendingPermission) {
    session.pendingPermission = undefined
  }
  const toolName = event.data.tool_name
  const projectName = getProjectSettings(session.project)?.label || extractProjectLabel(session.project)
  ctx.broadcastConversationScoped(
    {
      type: 'toast',
      conversationId,
      title: projectName,
      message: `Permission denied: ${toolName || 'unknown tool'}`,
    },
    session.project,
  )
}

/**
 * Elicitation: Claude is asking a structured question via the elicitation
 * protocol. Sets pendingAttention so the UI can prompt the user.
 */
export function handleElicitation(session: Conversation, event: HookEventOf<'Elicitation'>): void {
  session.pendingAttention = {
    type: 'elicitation',
    question: event.data.message,
    timestamp: event.timestamp,
  }
}

/**
 * Clear pendingAttention + stored request payloads when CC signals the
 * blocking interaction is done: PostToolUse, PostToolUseFailure,
 * ElicitationResult.
 */
export function clearPendingAttention(session: Conversation): void {
  if (session.pendingAttention) session.pendingAttention = undefined
  if (session.pendingPermission) session.pendingPermission = undefined
  if (session.pendingAskQuestion) session.pendingAskQuestion = undefined
}
