/**
 * Refcounted client-side accounting for THE WALL's single `wall` subscription.
 *
 * TEN PANES, ONE SUBSCRIPTION. Every pane acquires through here; the wire
 * `channel_subscribe` fires exactly once on the 0->1 transition and
 * `channel_unsubscribe` exactly once on the 1->0. A pane mounting while another
 * is unmounting -- the ordinary React swap -- never double-subscribes and never
 * drops the feed. Mirrors `agent-scope-subscription.ts`, deliberately: it is
 * the same problem with one scope instead of many.
 *
 * Module-level state on purpose: it must survive re-renders and outlive any one
 * component, exactly like the subscription tracking in use-websocket.ts. Tests
 * reset it with `resetWallSubscription()`.
 */

import { WALL_CHANNEL } from '@shared/wall'

/** Sends a single wire message to the broker. Injected so this module stays
 *  pure/testable -- the caller wires it to the live WebSocket `send`. */
export type WallSender = (msg: Record<string, unknown>) => void

let holders = 0

/** Acquire the wall feed. Idempotent: the Nth concurrent acquire only bumps the
 *  refcount; the wire subscribe fires once (0->1). */
export function subscribeWall(send: WallSender): void {
  holders++
  if (holders === 1) send({ type: 'channel_subscribe', channel: WALL_CHANNEL })
}

/** Release the wall feed. The wire unsubscribe fires once, on the last release
 *  (1->0). Releasing when nothing is held is a no-op. */
export function unsubscribeWall(send: WallSender): void {
  if (holders <= 0) return
  holders--
  if (holders === 0) send({ type: 'channel_unsubscribe', channel: WALL_CHANNEL })
}

/** How many panes are holding the feed right now. */
export function wallHolders(): number {
  return holders
}

/**
 * Reconnect recovery: the socket dropped so the broker forgot our subscription,
 * but the client still holds the refcount -- panes are still on screen. Re-send
 * `channel_subscribe` WITHOUT touching the count, exactly as
 * `resubscribeAgentScopes` does for agent scopes.
 */
export function resubscribeWall(send: WallSender): void {
  if (holders > 0) send({ type: 'channel_subscribe', channel: WALL_CHANNEL })
}

/** Drop all accounting without emitting an unsubscribe. For test isolation. */
export function resetWallSubscription(): void {
  holders = 0
}
