import { extractProjectLabel } from '../../../shared/project-uri'
import type { Conversation, HookEventOf } from '../../../shared/protocol'
import { getProjectSettings } from '../../project-settings'
import type { ConversationStoreContext } from '../event-context'

/**
 * PermissionRequest: Claude is blocked waiting for permission approval.
 */
export function handlePermissionRequest(conv: Conversation, event: HookEventOf<'PermissionRequest'>): void {
  const data = event.data
  const filePath = data.tool_input?.file_path
  conv.pendingAttention = {
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
  conv: Conversation,
  event: HookEventOf<'PermissionDenied'>,
): void {
  if (conv.pendingAttention?.type === 'permission') {
    conv.pendingAttention = undefined
  }
  if (conv.pendingPermission) {
    conv.pendingPermission = undefined
  }
  const toolName = event.data.tool_name
  const projectName = getProjectSettings(conv.project)?.label || extractProjectLabel(conv.project)
  ctx.broadcastConversationScoped(
    {
      type: 'toast',
      conversationId,
      title: projectName,
      message: `Permission denied: ${toolName || 'unknown tool'}`,
    },
    conv.project,
  )
}

/**
 * Elicitation: Claude is asking a structured question via the elicitation
 * protocol. Sets pendingAttention so the UI can prompt the user.
 */
export function handleElicitation(conv: Conversation, event: HookEventOf<'Elicitation'>): void {
  conv.pendingAttention = {
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
export function clearPendingAttention(conv: Conversation): void {
  if (conv.pendingAttention) conv.pendingAttention = undefined
  if (conv.pendingPermission) conv.pendingPermission = undefined
  if (conv.pendingAskQuestion) conv.pendingAskQuestion = undefined
}
