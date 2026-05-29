/**
 * Idempotent, refcounted client-side accounting for per-agent transcript
 * subscriptions -- the `(conversationId, agentId)` scope.
 *
 * This is the clean seam the agent detail view subscribes through today and the
 * future Picture-in-Picture layer (plan-agent-transcript-separation.md 7b) hangs
 * off tomorrow: several callers may hold a live subscription to the SAME scope
 * (e.g. a PiP tile AND the zoomed-in detail view of the same agent). The wire
 * `channel_subscribe` is sent exactly once on the 0->1 transition and
 * `channel_unsubscribe` exactly once on the 1->0 transition, so open/close races
 * across independent callers never double-subscribe or prematurely drop a scope.
 *
 * State is module-level on purpose -- it mirrors the existing module-level
 * subscription tracking in use-websocket.ts and must survive across React
 * renders. Tests reset it via `resetAgentScopes()`.
 */

/** Sends a single wire message to the broker. Injected so this module stays
 *  pure/testable -- the caller wires it to the live WebSocket `send`. */
export type ScopeSender = (msg: Record<string, unknown>) => void

const AGENT_CHANNEL = 'conversation:subagent_transcript'

/** key `${conversationId}:${agentId}` -> live holder count (always >= 1 while present). */
const refcounts = new Map<string, number>()

function scopeKey(conversationId: string, agentId: string): string {
  return `${conversationId}:${agentId}`
}

/** Split a scope key back into its parts. The agentId itself may contain ':',
 *  so split on the FIRST separator only. */
function splitScopeKey(key: string): { conversationId: string; agentId: string } {
  const i = key.indexOf(':')
  return { conversationId: key.slice(0, i), agentId: key.slice(i + 1) }
}

/** Acquire a subscription to an agent scope. Idempotent: the Nth concurrent
 *  acquire only bumps the refcount; the wire subscribe fires once (0->1). */
export function subscribeAgentScope(send: ScopeSender, conversationId: string, agentId: string): void {
  if (!conversationId || !agentId) return
  const key = scopeKey(conversationId, agentId)
  const next = (refcounts.get(key) ?? 0) + 1
  refcounts.set(key, next)
  if (next === 1) send({ type: 'channel_subscribe', channel: AGENT_CHANNEL, conversationId, agentId })
}

/** Release a subscription to an agent scope. The wire unsubscribe fires once,
 *  on the last release (1->0). Releasing an unheld scope is a no-op. */
export function unsubscribeAgentScope(send: ScopeSender, conversationId: string, agentId: string): void {
  if (!conversationId || !agentId) return
  const key = scopeKey(conversationId, agentId)
  const cur = refcounts.get(key) ?? 0
  if (cur <= 0) return
  if (cur === 1) {
    refcounts.delete(key)
    send({ type: 'channel_unsubscribe', channel: AGENT_CHANNEL, conversationId, agentId })
  } else {
    refcounts.set(key, cur - 1)
  }
}

/** Every scope currently held (refcount >= 1). */
export function activeAgentScopes(): Array<{ conversationId: string; agentId: string }> {
  return [...refcounts.keys()].map(splitScopeKey)
}

/** Reconnect recovery: the socket dropped so the broker forgot our channel
 *  subscriptions, but the client still holds the refcounts. Re-send a
 *  `channel_subscribe` for every live scope WITHOUT touching the counts. */
export function resubscribeAgentScopes(send: ScopeSender): void {
  for (const { conversationId, agentId } of activeAgentScopes()) {
    send({ type: 'channel_subscribe', channel: AGENT_CHANNEL, conversationId, agentId })
  }
}

/** Drop all accounting without emitting unsubscribes. For test isolation. */
export function resetAgentScopes(): void {
  refcounts.clear()
}
