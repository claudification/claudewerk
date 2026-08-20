/**
 * Everything the client says the moment a socket opens.
 *
 * A reconnect is not a resume: the broker forgot every subscription, and the
 * local picture may have drifted while the wire was down. So the handshake
 * re-asserts what this client is showing (conversation channels, agent scopes,
 * the wall, the debug-control grant), drops the state that cannot be trusted
 * across the gap, and then asks whether it missed anything.
 */

import { buildWebControlAdvertise } from '@/lib/web-control-grant'
import { resubscribeAgentScopes } from './agent-scope-subscription'
import { useConversationsStore } from './use-conversations'
import { resetWallFrames } from './wall-frame-store'
import { resubscribeWall } from './wall-subscription'
import { setSocketDepthProbe } from './ws-rtt'
import type { WsSend } from './ws-socket-types'
import { resetSubscribedConversations, subscribeConversationChannels } from './ws-subscription-watchers'
import { scheduleReconnectSyncCheck } from './ws-sync-protocol'

export function runOpenHandshake(ws: WebSocket, send: WsSend, subscribeConvChannels: boolean) {
  send({ type: 'subscribe', protocolVersion: 2 })

  // Hand the RTT store a pull for THIS socket's send-side backlog. The
  // socket is the only thing that knows its own bufferedAmount and it does
  // not survive a reconnect, so the seam is (re)bound per connection and
  // cleared on close rather than read out of a module-level ref.
  setSocketDepthProbe(() => ws.bufferedAmount)

  const selectedConversationId = applyConnectedState(ws)

  // Reset subscription tracking - only current conversation
  resetSubscribedConversations()

  // Subscribe current conversation immediately (skipped on a canvas-only socket).
  if (subscribeConvChannels && selectedConversationId) {
    subscribeConversationChannels(send, selectedConversationId)
  }

  // Re-send channel_subscribe for every held agent scope. The broker forgot
  // our subscriptions across the drop, but the refcounts still describe what
  // the client is showing (selected agent view + any future PiP tiles). Goes
  // through the seam so counts are preserved. `selectedSubagentId` is implied
  // by a held scope, so this subsumes the old single-agent re-subscribe.
  resubscribeAgentScopes(send)

  // Same contract for THE WALL's single channel: the panes are still
  // mounted, so the client still holds the refcount -- re-assert the
  // subscription without touching it. The broker answers with a fresh
  // `full: true` snapshot, which is why the local picture is dropped
  // first rather than left to drift against a wall we are no longer on.
  resetWallFrames()
  resubscribeWall(send)

  // Re-advertise the web debug-control grant if one is active. The grant
  // lives in localStorage so it survives full reload / SW update; on every
  // (re)connect we re-announce the SAME stable clientId so the agent keeps
  // targeting this browser across socket churn. No grant -> no advertise
  // (default-deny: the broker never targets a browser it can't see).
  const advertise = buildWebControlAdvertise()
  if (advertise) send({ type: 'web_control_advertise', ...advertise })

  scheduleReconnectSyncCheck(send)
}

/**
 * Single batched setState for ALL onopen state changes, returning the selected
 * conversation the caller needs to re-subscribe.
 *
 * Multiple separate setState calls fire Zustand subscribers individually,
 * causing useSyncExternalStore tearing detection to loop (React #310).
 */
function applyConnectedState(ws: WebSocket): string | null {
  const { selectedConversationId, transcripts, events, connectSeq } = useConversationsStore.getState()

  // Evict stale conversations from LIFO cache (non-selected conversations may have missed WS entries)
  const evictedSids = Object.keys(transcripts).filter(sid => sid !== selectedConversationId)
  let newTranscripts = transcripts
  let newEvents = events
  if (evictedSids.length > 0) {
    newTranscripts = { ...transcripts }
    newEvents = { ...events }
    for (const sid of evictedSids) {
      delete newTranscripts[sid]
      delete newEvents[sid]
    }
    console.log(`[sync] reconnect: evicted ${evictedSids.length} stale conversations from LIFO cache`)
  }

  // ONE setState call instead of 5 separate ones
  useConversationsStore.setState({
    isConnected: true,
    error: null,
    ws,
    transcripts: newTranscripts,
    events: newEvents,
    connectSeq: connectSeq + 1,
  })

  return selectedConversationId
}
