/**
 * Tool-permission relay: agent host <-> control panel.
 *
 * The wire relay is only half the job. Every gate also leaves a pair of
 * transcript entries -- the ASK where CC asked, the ANSWER naming the outcome,
 * the human, and the wait (see `permission-receipts.ts`). That pair is what the
 * panel renders as one inline card, and what survives reload.
 *
 * AskUserQuestion and clipboard capture used to live here too; they are their
 * own modules now (`ask-question.ts`, `clipboard.ts`).
 */

import { schedulePermissionNotify } from '../attention-notify'
import type { HandlerContext, MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, DASHBOARD_ROLES, registerHandlers } from '../message-router'
import { resolvePermissionGate } from '../permission-resolve'
import { emitPermissionDecisionEntry, emitPermissionRequestEntry } from './permission-receipts'
import { conversationForBroadcast, forwardToAgentHost } from './relay-helpers'

/**
 * Is a dashboard actually LOOKING at this conversation right now? Subscription
 * to its transcript channel is the honest test -- a panel open on some other
 * conversation is no more use than a closed laptop when a gate blocks here.
 * Drives the push grace: watched gates wait, unwatched ones buzz immediately.
 */
function hasLiveViewer(ctx: HandlerContext, conversationId: string): boolean {
  return ctx.conversations.getChannelSubscribers('conversation:transcript', conversationId).size > 0
}

/** Record the open gate on the conversation so a reconnecting dashboard
 *  rehydrates the prompt instead of losing it with the socket. */
function mirrorPending(ctx: HandlerContext, conversationId: string, data: Record<string, unknown>): void {
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) return
  const toolName = data.toolName as string
  conversation.pendingPermission = {
    requestId: data.requestId as string,
    toolName,
    description: data.description as string,
    inputPreview: data.inputPreview as string,
    toolUseId: data.toolUseId as string | undefined,
    timestamp: Date.now(),
  }
  conversation.pendingAttention = { type: 'permission', toolName, timestamp: Date.now() }
  ctx.conversations.persistConversationById(conversationId)
  ctx.conversations.broadcastConversationUpdate(conversationId)
}

/** Agent host -> dashboard: CC is blocked on a tool permission.
 *  Mirrors onto the conversation for reconnect recovery, stamps the ASK into
 *  the transcript, and arms the push timer. */
const permissionRequest: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const requestId = data.requestId as string
  const toolName = data.toolName as string

  // Mirror BEFORE the project check: a conversation with no project still needs
  // its pending record, or a reconnecting dashboard forgets the gate exists.
  mirrorPending(ctx, conversationId, data)

  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation?.project) {
    ctx.log.debug(`[permission] dropping request: no project on ${conversationId.slice(0, 8)}`)
    return
  }

  emitPermissionRequestEntry(ctx.conversations, conversationId, {
    requestId,
    toolUseId: data.toolUseId as string | undefined,
    toolName,
    description: data.description as string | undefined,
    inputPreview: data.inputPreview as string | undefined,
  })

  ctx.broadcastScoped(
    {
      type: 'permission_request',
      conversationId,
      requestId,
      toolName,
      description: data.description,
      inputPreview: data.inputPreview,
      toolUseId: data.toolUseId,
    },
    conversation.project,
  )

  schedulePermissionNotify({
    conversationId,
    project: conversation.project,
    requestId,
    toolName,
    detail: (data.inputPreview as string | undefined) || (data.description as string | undefined),
    hasLiveViewer: hasLiveViewer(ctx, conversationId),
  })

  ctx.log.debug(`[permission] Request: ${requestId} ${toolName}`)
}

// Dashboard -> agent host. The gate itself is resolved by the shared resolver
// so this path and the push-notification route cannot drift.
const permissionResponse: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (conversation) ctx.requirePermission('chat', conversation.project)

  resolvePermissionGate(ctx.conversations, {
    conversationId,
    requestId: data.requestId as string,
    behavior: data.behavior === 'allow' ? 'allow' : 'deny',
    rule: data.rule === true,
    // From the authenticated socket -- a client cannot sign someone else's name.
    decidedBy: ctx.ws.data.userName,
  })
}

// Permission rule: dashboard -> agent host (conversation-scoped auto-approve).
// No receipt of its own -- the ALWAYS press already stamped one decision entry
// with outcome `allowed_always`.
const permissionRule: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (conversation) ctx.requirePermission('chat', conversation.project)
  const sent = forwardToAgentHost(
    ctx,
    conversationId,
    { type: 'permission_rule', toolName: data.toolName, behavior: data.behavior },
    'permission',
  )
  if (!sent) return
  ctx.log.info(
    `[permission] Rule conv=${conversationId?.slice(0, 8)} tool=${data.toolName} -> ${data.behavior} by=${ctx.ws.data.userName ?? 'anonymous'}`,
  )
}

// Agent host -> dashboard: a standing rule approved this with no human in the
// loop. Stamped as a receipt too, so an unattended run's tool gates are as
// auditable as an attended one's.
const permissionAutoApproved: MessageHandler = (ctx, data) => {
  const target = conversationForBroadcast(ctx, data, 'permission', 'auto-approved')
  if (!target) return
  const { conversationId, conversation } = target
  const requestId = data.requestId as string
  const toolName = data.toolName as string

  emitPermissionDecisionEntry(ctx.conversations, conversationId, {
    requestId,
    toolName,
    outcome: 'auto',
  })

  ctx.broadcastScoped(
    {
      type: 'permission_auto_approved',
      conversationId,
      requestId,
      toolName,
      description: data.description,
    },
    conversation.project,
  )
}

export function registerPermissionHandlers(): void {
  registerHandlers(
    { permission_request: permissionRequest, permission_auto_approved: permissionAutoApproved },
    AGENT_HOST_ONLY,
  )
  registerHandlers({ permission_response: permissionResponse, permission_rule: permissionRule }, DASHBOARD_ROLES)
}
