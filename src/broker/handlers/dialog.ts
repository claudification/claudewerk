/**
 * Dialog handlers: rich UI dialog relay between agent host and dashboard.
 *
 * Flow:
 *   Claude -> mcp__rclaude__dialog(layout) -> agent host -> dialog_show -> broker
 *   -> broadcast to dashboard subscribers -> user interacts -> dialog_result
 *   -> broker -> forward to agent host -> resolve MCP tool call
 */

import type { DialogLayout } from '../../shared/dialog-schema'
import { cancelDialogNotify, resetDialogNotifyTimer, scheduleDialogNotify } from '../attention-notify'
import type { MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, DASHBOARD_ROLES, registerHandlers } from '../message-router'

type DialogHandlerContext = Parameters<MessageHandler>[0]

// Clear a conversation's pending dialog + dialog attention, then persist +
// broadcast. Shared by the answered/cancelled/hard-dismiss paths.
function clearDialogState(ctx: DialogHandlerContext, conversationId: string): void {
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) return
  delete conversation.pendingDialog
  if (conversation.pendingAttention?.type === 'dialog') {
    delete conversation.pendingAttention
  }
  ctx.conversations.persistConversationById(conversationId)
  ctx.conversations.broadcastConversationUpdate(conversationId)
}

// Dialog show: agent host -> broker -> dashboard (broadcast)
const dialogShow: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return

  const dialogId = data.dialogId as string
  const layout = data.layout as Record<string, unknown>
  if (!dialogId || !layout) return

  // Store pending dialog on the conversation for reconnect recovery + attention indicator
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) {
    conversation.pendingDialog = {
      dialogId,
      layout: layout as unknown as DialogLayout,
      timestamp: Date.now(),
    }
    conversation.pendingAttention = {
      type: 'dialog',
      question: (layout.title as string) || 'Dialog',
      timestamp: Date.now(),
    }
    ctx.conversations.persistConversationById(conversationId)
    ctx.conversations.broadcastConversationUpdate(conversationId)
  }

  // Broadcast to dashboard subscribers with access to this conversation's project.
  // Drop on missing project -- a global broadcast would leak dialog content to
  // users without access. (Audit C2 class)
  if (!conversation?.project) {
    ctx.log.debug(`[dialog] dropping show: no project on ${conversationId.slice(0, 8)}`)
    return
  }
  const dialogMsg = {
    type: 'dialog_show',
    conversationId: conversationId,
    dialogId,
    layout,
  }
  ctx.broadcastScoped(dialogMsg, conversation.project)

  scheduleDialogNotify({
    conversationId,
    project: conversation.project,
    dialogTitle: (layout.title as string) || 'Dialog',
  })

  ctx.log.info(
    `[dialog] Show: "${layout.title}" (${dialogId.toString().slice(0, 8)}) conversation=${conversationId.slice(0, 8)}`,
  )
}

// Resolve a dialog result's effect on broker state. A user CANCEL of a still-
// live dialog keeps it re-displayable (mark expired, like a timeout) so the user
// can re-trigger it from the transcript / pill and answer late; everything else
// (a real submit, or a cancel of an ALREADY-expired dialog = the pill's discard)
// clears it. Returns whether this was that first re-displayable cancel.
function applyDialogResolution(
  ctx: DialogHandlerContext,
  conversationId: string,
  dialogId: string,
  result: Record<string, unknown>,
): boolean {
  const conversation = ctx.conversations.getConversation(conversationId)
  const firstCancel =
    result._cancelled === true &&
    conversation?.pendingDialog?.dialogId === dialogId &&
    conversation.pendingDialog.expired !== true
  if (firstCancel && conversation?.pendingDialog) {
    conversation.pendingDialog.expired = true
    if (conversation.pendingAttention?.type === 'dialog') {
      delete conversation.pendingAttention
    }
    ctx.conversations.persistConversationById(conversationId)
    ctx.conversations.broadcastConversationUpdate(conversationId)
    ctx.log.info(
      `[dialog] Cancelled (re-displayable): ${dialogId.slice(0, 8)} conversation=${conversationId.slice(0, 8)}`,
    )
  } else {
    clearDialogState(ctx, conversationId)
  }
  return firstCancel
}

// Dialog result: dashboard -> broker -> agent host (forward)
const dialogResult: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  const dialogId = data.dialogId as string
  const result = data.result as Record<string, unknown>

  if (!conversationId || !dialogId || !result) return

  // Permission check: user must have chat permission for this conversation
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (conversation) ctx.requirePermission('chat', conversation.project)

  // Late answer: the dialog already timed out (expired) on the agent host but the
  // user re-displayed it and submitted. Tag the result `_late` (+ title) so the
  // agent host delivers it as a labeled late answer instead of dropping it. The
  // dialogId must still match -- a stale result for a replaced dialog is not late.
  const expired = conversation?.pendingDialog?.expired === true && conversation.pendingDialog.dialogId === dialogId
  if (expired && conversation?.pendingDialog) {
    result._late = true
    result._dialogTitle = (conversation.pendingDialog.layout as { title?: string })?.title || 'Dialog'
  }

  const firstCancel = applyDialogResolution(ctx, conversationId, dialogId, result)

  cancelDialogNotify(conversationId)

  // Forward to the agent host that owns this conversation
  const targetWs = ctx.conversations.getConversationSocket(conversationId)
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: 'dialog_result',
        conversationId: conversationId,
        dialogId,
        result,
      }),
    )
    ctx.log.info(
      `[dialog] Result: ${dialogId.slice(0, 8)} action=${result._action}${expired ? ' LATE' : ''} conversation=${conversationId.slice(0, 8)}`,
    )
  } else {
    ctx.log.error(`[dialog] No socket for conversation ${conversationId.slice(0, 8)}`)
  }

  // Broadcast dismiss to other dashboard subscribers (clean up UI). On a first
  // cancel, carry reason 'cancelled' so their modal collapses to the re-
  // displayable pill instead of vanishing (mirrors the timeout path).
  if (conversation?.project) {
    const dismissMsg = {
      type: 'dialog_dismiss',
      conversationId: conversationId,
      dialogId,
      ...(firstCancel ? { reason: 'cancelled' as const } : {}),
    }
    ctx.broadcastScoped(dismissMsg, conversation.project)
  }
}

// Dialog dismiss: agent host -> broker -> dashboard
// (e.g. timeout on agent host side, conversation ended)
const dialogDismiss: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  const dialogId = data.dialogId as string
  if (!conversationId || !dialogId) return

  const reason = data.reason as string | undefined
  const conversation = ctx.conversations.getConversation(conversationId)

  // Timeout/cancel dismiss: don't destroy the dialog -- mark it expired and keep
  // the layout so the user can re-display + answer it late. Clear the attention
  // nag (the agent already received the timeout/cancel message). The dashboard
  // renders an "expired" pill instead of the blocking modal. (The cancel path
  // also arrives here as the agent host's follow-up dismiss after it resolves
  // the cancelled MCP call -- without this it would hard-clear the state that
  // the dialog_result handler just preserved.)
  if (
    (reason === 'timeout' || reason === 'cancelled') &&
    conversation?.pendingDialog?.dialogId === dialogId
  ) {
    conversation.pendingDialog.expired = true
    if (conversation.pendingAttention?.type === 'dialog') {
      delete conversation.pendingAttention
    }
    ctx.conversations.persistConversationById(conversationId)
    ctx.conversations.broadcastConversationUpdate(conversationId)
    cancelDialogNotify(conversationId)
    if (conversation.project) {
      ctx.broadcastScoped({ type: 'dialog_dismiss', conversationId, dialogId, reason }, conversation.project)
    }
    ctx.log.info(
      `[dialog] Expired (re-displayable, ${reason}): ${dialogId.slice(0, 8)} conversation=${conversationId.slice(0, 8)}`,
    )
    return
  }

  // Hard dismiss (answered/cancelled/conversation ended): clear everything.
  clearDialogState(ctx, conversationId)

  cancelDialogNotify(conversationId)

  if (conversation?.project) {
    const dismissMsg2 = { type: 'dialog_dismiss', conversationId: conversationId, dialogId }
    ctx.broadcastScoped(dismissMsg2, conversation.project)
  }

  ctx.log.debug(`[dialog] Dismiss: ${dialogId.slice(0, 8)} conversation=${conversationId.slice(0, 8)}`)
}

// Dialog keepalive: dashboard -> broker -> agent host (extend timeout)
const dialogKeepalive: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  const dialogId = data.dialogId as string
  if (!conversationId || !dialogId) return

  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) ctx.requirePermission('chat', conversation.project)

  const targetWs = ctx.conversations.getConversationSocket(conversationId)
  if (targetWs) {
    targetWs.send(JSON.stringify({ type: 'dialog_keepalive', dialogId }))
  }

  // User is actively interacting -- restart the 4-min notification clock so
  // we don't push to someone who already has the dialog open.
  if (conversation?.project) {
    resetDialogNotifyTimer({
      conversationId,
      project: conversation.project,
      dialogTitle: (conversation.pendingDialog?.layout as { title?: string })?.title || 'Dialog',
    })
  }
}

export function registerDialogHandlers(): void {
  // Agent host -> dashboard (show/dismiss).
  registerHandlers({ dialog_show: dialogShow, dialog_dismiss: dialogDismiss }, AGENT_HOST_ONLY)
  // Dashboard -> agent host (user response / keepalive).
  registerHandlers({ dialog_result: dialogResult, dialog_keepalive: dialogKeepalive }, DASHBOARD_ROLES)
}
