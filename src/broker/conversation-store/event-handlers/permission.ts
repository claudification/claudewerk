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
 * Is a dialog still on the user's screen, waiting to be answered?
 *
 * Both slots count: `pendingDialog` is the one-shot dialog, `liveDialog` the
 * persistent one (THE DIALOGUE), and either means a human is still expected to
 * act.
 */
function hasOpenDialog(conv: Conversation): boolean {
  return conv.pendingDialog !== undefined || conv.liveDialog?.snapshot.status === 'open'
}

/**
 * Clear pendingAttention + stored request payloads when CC signals the
 * blocking interaction is done: PostToolUse, PostToolUseFailure,
 * ElicitationResult.
 *
 * EXCEPT a dialog that is still open. `mcp__rclaude__dialog` returns the instant
 * the dialog is SHOWN (44 ms measured) -- the dialog stays up and the answer
 * arrives later as its own channel message -- so its `PostToolUse` lands ~200 ms
 * after `dialog_show` and used to delete the attention flag that had just been
 * set. A live 2026-08-19 trace (conversation 88739d3a) left a dialog open for
 * twelve minutes with the conversation reporting that it needed nothing: gone
 * from Pulse, gone from every "who is waiting on me" surface.
 *
 * A dialog's attention is retired by the dialog's OWN lifecycle -- `clearDialogState`
 * in handlers/dialog.ts on answer/cancel/dismiss, and dialog-live.ts on a
 * non-open snapshot. A tool result is not that lifecycle and must not act like it.
 * Attention with no dialog behind it is still cleared: an orphan is dead.
 */
export function clearPendingAttention(conv: Conversation): void {
  const shielded = conv.pendingAttention?.type === 'dialog' && hasOpenDialog(conv)
  if (conv.pendingAttention && !shielded) conv.pendingAttention = undefined
  if (conv.pendingPermission) conv.pendingPermission = undefined
  if (conv.pendingAskQuestion) conv.pendingAskQuestion = undefined
}
