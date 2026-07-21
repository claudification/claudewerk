/**
 * Resolve a `?share=<token>` WebSocket upgrade to the guest socket it should mint.
 *
 * There are TWO independent share systems and one query param, so this is the
 * seam that decides which one a token belongs to:
 *   - conversation shares (shares.ts, the polymorphic token store), and
 *   - canvas shares (a token native to the canvas row -- see canvas-store.ts).
 *
 * Conversation tokens are tried first because they predate canvases and are the
 * common case; the two namespaces are disjoint random tokens, so order only
 * decides which lookup runs first, never which one wins.
 *
 * Kept out of index.ts's `fetch` deliberately: that handler is already the most
 * branch-heavy function in the broker, and auth decisions do not belong inside a
 * router. Pure apart from the two token lookups, so it unit-tests directly.
 */

import { validateCanvasShare } from './canvas-store'
import type { WsData } from './handler-context'
import { shareToGrants, validateShare } from './shares'

/** The WsData fields a share upgrade contributes, or null to reject the socket. */
export type ShareUpgrade = Partial<WsData> | null

/**
 * Build the guest WsData for a share token, or null when the token resolves to
 * nothing (unknown, revoked, or expired -- the caller answers 401 either way and
 * never says which, so a probe learns nothing).
 */
export function resolveShareUpgrade(token: string): ShareUpgrade {
  const conversation = validateShare(token)
  if (conversation) {
    return {
      isShare: true,
      shareToken: token,
      shareConversationId: conversation.conversationId,
      hideUserInput: conversation.hideUserInput || false,
      grants: shareToGrants(conversation),
    }
  }

  const canvas = validateCanvasShare(token)
  if (canvas) {
    // No grants: a canvas guest is not a project member. Their entire capability
    // is "this canvas, at this tier", carried by shareCanvasId/shareCanvasTier and
    // enforced at canvas_join. Every other handler sees an ungranted socket.
    return {
      isShare: true,
      shareToken: token,
      shareCanvasId: canvas.id,
      shareCanvasTier: canvas.shareTier ?? 'read',
      grants: [],
    }
  }

  return null
}
