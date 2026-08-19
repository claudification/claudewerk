/**
 * HTTP route for answering a tool-permission gate:
 *
 *   POST /api/permissions/respond   { conversationId, requestId, behavior }
 *
 * This exists for ONE caller: the service worker, handling a tap on a push
 * notification's ALLOW / DENY button. A service worker has no WebSocket and no
 * access to the page's memory, but its `fetch` does carry the same-origin
 * session cookie -- so the gate can be answered from the lock screen without
 * opening the panel.
 *
 * Everything past the permission check is the shared resolver, so an answer
 * given here is indistinguishable from one given in the panel.
 */

import { Hono } from 'hono'
import { getAuthenticatedUser } from '../auth-routes'
import type { ConversationStore } from '../conversation-store'
import { resolvePermissionGate } from '../permission-resolve'
import type { RouteHelpers } from './shared'

interface RespondBody {
  conversationId?: unknown
  requestId?: unknown
  behavior?: unknown
}

interface ParsedRespond {
  conversationId: string
  requestId: string
  behavior: 'allow' | 'deny'
}

/** Null for anything malformed -- an unrecognised behavior is rejected rather
 *  than guessed at, because guessing wrong grants a tool call nobody approved. */
function parseRespondBody(body: RespondBody): ParsedRespond | null {
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : ''
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  if (!(conversationId && requestId)) return null
  if (body.behavior !== 'allow' && body.behavior !== 'deny') return null
  return { conversationId, requestId, behavior: body.behavior }
}

export function createPermissionsRouter(conversationStore: ConversationStore, helpers: RouteHelpers): Hono {
  const app = new Hono()

  app.post('/api/permissions/respond', async c => {
    const parsed = parseRespondBody((await c.req.json().catch(() => ({}))) as RespondBody)
    if (!parsed) {
      return c.json({ error: 'conversationId, requestId and behavior (allow|deny) are required' }, 400)
    }
    const { conversationId, requestId, behavior } = parsed

    const conversation = conversationStore.getConversation(conversationId)
    if (!conversation) return c.json({ error: 'Unknown conversation' }, 404)
    if (!helpers.httpHasPermission(c.req.raw, 'chat', conversation.project, conversationId)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const result = resolvePermissionGate(conversationStore, {
      conversationId,
      requestId,
      behavior,
      // The cookie session names the human. A bearer-secret caller has no
      // identity, and the receipt says so rather than inventing one.
      decidedBy: getAuthenticatedUser(c.req.raw) ?? undefined,
    })

    // `resolved: false` is not an error -- someone answered from the panel
    // first. The notification action is late, not wrong.
    return c.json({ ok: true, resolved: result.resolved, forwarded: result.forwarded })
  })

  return app
}
