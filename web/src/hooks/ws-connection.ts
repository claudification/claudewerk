/**
 * Connection lifecycle: open one socket and wire its four events to the
 * modules that own them -- handshake, close policy, message router.
 */

import { buildWsUrl } from '@/lib/share-mode'
import { useConversationsStore } from './use-conversations'
import { createCloseHandler } from './ws-close-policy'
import { createMessageHandler } from './ws-message-router'
import { runOpenHandshake } from './ws-open-handshake'
import type { SocketRef, TimerRef, WsSend } from './ws-socket-types'

let _wsUrl: string | null = null
function getWsUrl() {
  if (!_wsUrl) _wsUrl = buildWsUrl()
  return _wsUrl
}

export interface WsConnectionOptions {
  wsRef: SocketRef
  reconnectTimeoutRef: TimerRef
  /** Serializes + meters; reads wsRef, so it works for the socket being opened. */
  send: WsSend
  /** Re-enter the hook's connect() -- the close policy's retry. */
  reconnect: () => void
  /** False on a canvas-only socket: never subscribe conversation channels. */
  subscribeConvChannels: boolean
}

/** Open a socket unless one is already up. Never throws: a failed open just reports disconnected. */
export function openWsConnection(opts: WsConnectionOptions) {
  const { wsRef, reconnectTimeoutRef, send, reconnect, subscribeConvChannels } = opts
  if (wsRef.current?.readyState === WebSocket.OPEN) return

  try {
    const ws = new WebSocket(getWsUrl())
    wsRef.current = ws

    const handleClose = createCloseHandler(reconnect, reconnectTimeoutRef)

    ws.onopen = () => runOpenHandshake(ws, send, subscribeConvChannels)

    ws.onclose = e => {
      wsRef.current = null
      handleClose(e)
    }

    ws.onerror = () => {
      useConversationsStore.setState({ error: `WebSocket connection failed: ${getWsUrl()}` })
    }

    ws.onmessage = createMessageHandler(send)
  } catch {
    useConversationsStore.setState({ isConnected: false })
  }
}
