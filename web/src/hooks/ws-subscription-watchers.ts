/**
 * Subscription reconciliation: keep the broker's idea of what this client is
 * watching in step with what the client is actually showing.
 *
 * Two watchers, both store subscriptions that diff rather than re-assert:
 * conversation channels follow the LIFO transcript cache (so a cached-but-not-
 * selected conversation keeps streaming), and the agent scope follows the
 * selected-subagent view through the refcounted seam.
 *
 * The subscribed set is module-level because the open handshake has to clear it
 * -- the broker forgets every subscription across a drop, so the client's idea
 * of "already subscribed" has to be dropped with it.
 */

import { subscribeAgentScope, unsubscribeAgentScope } from './agent-scope-subscription'
import { useConversationsStore } from './use-conversations'
import type { SocketRef, WsSend } from './ws-socket-types'

const CONVERSATION_CHANNELS = [
  'conversation:events',
  'conversation:transcript',
  'conversation:tasks',
  'conversation:bg_output',
] as const

type ConversationsState = ReturnType<typeof useConversationsStore.getState>
type AgentScope = { conversationId: string; agentId: string }

let subscribedConversations = new Set<string>()

/** Forget every held conversation subscription (the broker just forgot them too). */
export function resetSubscribedConversations() {
  subscribedConversations = new Set<string>()
}

/** Subscribe one conversation's four channels and record it as held. */
export function subscribeConversationChannels(send: WsSend, conversationId: string) {
  sendChannelOp(send, 'channel_subscribe', conversationId)
  subscribedConversations.add(conversationId)
}

function sendChannelOp(send: WsSend, type: 'channel_subscribe' | 'channel_unsubscribe', conversationId: string) {
  for (const channel of CONVERSATION_CHANNELS) {
    send({ type, channel, conversationId })
  }
}

/**
 * Watch for conversation selection changes and manage channel subscriptions.
 * Diff-based: keep subscriptions alive for LIFO-cached conversations.
 * Uses selector-based subscribe to only fire when selectedConversationId or
 * transcript keys change. Returns the teardown.
 *
 * `enabled: false` is the canvas-only socket, which never manages conversation
 * channels at all.
 */
export function watchConversationSubscriptions(wsRef: SocketRef, send: WsSend, enabled: boolean): () => void {
  let lastSelectedId: string | null = null
  let lastTranscriptKeys = ''

  return useConversationsStore.subscribe(state => {
    // Canvas-only sockets never manage conversation-channel subscriptions.
    if (!enabled || !isOpen(wsRef)) return

    // Quick check: bail if nothing subscription-relevant changed
    const transcriptKeys = Object.keys(state.transcripts).sort().join(',')
    if (state.selectedConversationId === lastSelectedId && transcriptKeys === lastTranscriptKeys) return
    lastSelectedId = state.selectedConversationId
    lastTranscriptKeys = transcriptKeys

    applySubscriptionDiff(send, desiredConversations(state))
  })
}

/** Selected + every conversation still holding a cached transcript. */
function desiredConversations(state: ConversationsState): Set<string> {
  const desired = new Set<string>()
  if (state.selectedConversationId) desired.add(state.selectedConversationId)
  for (const sid of Object.keys(state.transcripts)) {
    if (state.transcripts[sid]?.length) desired.add(sid)
  }
  return desired
}

function applySubscriptionDiff(send: WsSend, desired: Set<string>) {
  // Unsubscribe conversations no longer in cache
  for (const sid of subscribedConversations) {
    if (!desired.has(sid)) sendChannelOp(send, 'channel_unsubscribe', sid)
  }
  // Subscribe new conversation
  for (const sid of desired) {
    if (!subscribedConversations.has(sid)) sendChannelOp(send, 'channel_subscribe', sid)
  }
  subscribedConversations = desired
}

/**
 * Watch for the selected-agent view (open/close) and acquire/release its
 * transcript scope through the refcounted seam. Releasing the previous scope
 * and acquiring the next on the same tick is the open/close race the seam's
 * refcounting absorbs -- a future PiP tile holding the same scope keeps it
 * alive across a detail-view close. Tracks the previous scope's PARTS (not a
 * joined key) so an agentId containing ':' round-trips cleanly.
 * Returns the teardown.
 */
export function watchAgentScope(wsRef: SocketRef, send: WsSend): () => void {
  let prevScope: AgentScope | null = null

  return useConversationsStore.subscribe(state => {
    if (!isOpen(wsRef)) return
    const next = selectedScope(state)
    if (sameScope(next, prevScope)) return

    if (prevScope) unsubscribeAgentScope(send, prevScope.conversationId, prevScope.agentId)
    if (next) subscribeAgentScope(send, next.conversationId, next.agentId)
    prevScope = next
  })
}

/** The agent scope the detail view is showing, or null when it is closed. */
function selectedScope(state: ConversationsState): AgentScope | null {
  const conversationId = state.selectedConversationId
  const agentId = state.selectedSubagentId
  return conversationId && agentId ? { conversationId, agentId } : null
}

function sameScope(a: AgentScope | null, b: AgentScope | null): boolean {
  if (!a || !b) return !a && !b
  return a.conversationId === b.conversationId && a.agentId === b.agentId
}

function isOpen(wsRef: SocketRef): boolean {
  return wsRef.current?.readyState === WebSocket.OPEN
}
