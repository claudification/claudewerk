/**
 * The two moves every agent-host <-> dashboard relay makes, written once.
 *
 * Each relay used to open with its own copy of "resolve the conversation, bail
 * if it has no project" and close with its own copy of "find the host socket
 * and send". Identical code, one `[tag]` apart -- which is how a fix to one
 * copy stops being a fix to the others.
 */

import type { Conversation } from '../../shared/protocol'
import type { HandlerContext } from '../handler-context'

/**
 * Resolve the conversation a relayed message is about, refusing to continue if
 * it has no project.
 *
 * The project is the permission key. A broadcast without one cannot be scoped,
 * and an unscoped broadcast of tool input or clipboard contents would reach
 * dashboards with no access to that project (the C2 audit class). Dropping is
 * the only safe answer.
 *
 * @param tag  Log prefix identifying the relay (`permission`, `clipboard`).
 * @param what What is being dropped, for the log line.
 */
export function conversationForBroadcast(
  ctx: HandlerContext,
  data: Record<string, unknown>,
  tag: string,
  what: string,
): { conversationId: string; conversation: Conversation } | null {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return null
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation?.project) {
    ctx.log.debug(`[${tag}] dropping ${what}: no project on ${conversationId.slice(0, 8)}`)
    return null
  }
  return { conversationId, conversation }
}

/**
 * Record an interaction the agent is BLOCKED on (a gate, a question, a dialog,
 * a plan approval) onto the conversation, and tell the dashboards.
 *
 * Without this, the prompt lives only in the socket that delivered it: a
 * reconnecting panel comes back with no idea the agent is waiting, and the
 * attention indicator has nothing to show. Each caller owns a different pending
 * field, so it supplies the assignment; the persist + broadcast + attention slot
 * are the same every time.
 *
 * Runs BEFORE any project check on purpose -- a conversation whose project is
 * missing still needs its pending record, even though nothing can be broadcast.
 */
export function mirrorPendingInteraction(
  ctx: HandlerContext,
  conversationId: string,
  attention: NonNullable<Conversation['pendingAttention']>,
  assign: (conversation: Conversation) => void,
): void {
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) return
  assign(conversation)
  conversation.pendingAttention = attention
  ctx.conversations.persistConversationById(conversationId)
  ctx.conversations.broadcastConversationUpdate(conversationId)
}

/**
 * Send a payload to the agent host that owns a conversation.
 *
 * @returns true if it went out. A missing socket is logged, never thrown: the
 *          caller still has cleanup to do (clearing pending state) and skipping
 *          it would strand a prompt that can never be answered.
 */
export function forwardToAgentHost(
  ctx: HandlerContext,
  conversationId: string,
  payload: Record<string, unknown>,
  tag: string,
): boolean {
  const targetWs = conversationId ? ctx.conversations.getConversationSocket(conversationId) : null
  if (!targetWs) {
    ctx.log.error(`[${tag}] no agent-host socket for ${conversationId?.slice(0, 8) ?? 'unknown'}`)
    return false
  }
  targetWs.send(JSON.stringify({ conversationId, ...payload }))
  return true
}
