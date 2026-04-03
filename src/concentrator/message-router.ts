/**
 * Message router: dispatches WS messages to handler functions.
 * Handlers register by message type. Guards throw GuardError
 * which the router catches and sends as error replies.
 */

import { GuardError, type HandlerContext, type MessageHandler } from './handler-context'

const handlers = new Map<string, MessageHandler>()

/** Register a handler for a message type */
export function registerHandler(type: string, handler: MessageHandler): void {
  handlers.set(type, handler)
}

/** Register multiple handlers at once */
export function registerHandlers(map: Record<string, MessageHandler>): void {
  for (const [type, handler] of Object.entries(map)) {
    handlers.set(type, handler)
  }
}

/** Route a message to its handler. Returns true if handled. */
export function routeMessage(ctx: HandlerContext, type: string, data: Record<string, unknown>): boolean {
  const handler = handlers.get(type)
  if (!handler) return false

  try {
    handler(ctx, data)
  } catch (err) {
    if (err instanceof GuardError) {
      // Guard failures: send error reply with the conventional _result suffix
      const replyType = type.includes('channel_') ? `${type}_result` : type
      ctx.reply({ type: replyType, ok: false, error: err.message })
    } else {
      // Unexpected errors: log and send generic error
      console.error(`[router] Handler error for ${type}:`, err)
      ctx.reply({ type: `${type}_result`, ok: false, error: 'Internal error' })
    }
  }

  return true
}

/** Check if a handler is registered for a type */
export function hasHandler(type: string): boolean {
  return handlers.has(type)
}
