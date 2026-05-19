/**
 * Shared agent-host socket resolution for handlers that forward a message to
 * a specific conversation's host (send_input, send_interrupt, daemon control).
 *
 * The direct conversation->socket map is the fast path; the connection-id
 * routing table is the fallback that covers the revive / multi-connection
 * window where a conversation has live sockets registered only by
 * connection id.
 */
import type { ServerWebSocket } from 'bun'
import type { HandlerContext } from '../handler-context'

/**
 * Resolve the live agent-host WebSocket for a conversation, or `undefined`
 * when no live socket is registered. Tries the direct map, then walks the
 * connection-id routing table.
 */
export function resolveConversationSocket(
  ctx: HandlerContext,
  conversationId: string,
): ServerWebSocket<unknown> | undefined {
  const direct = ctx.conversations.getConversationSocket(conversationId)
  if (direct) return direct
  for (const connectionId of ctx.conversations.getConnectionIds(conversationId)) {
    const ws = ctx.conversations.findSocketByConversationId(connectionId)
    if (ws) return ws
  }
  return undefined
}
