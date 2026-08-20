/**
 * WebSocket hook for real-time updates from broker.
 *
 * This module is now only the React half: refs, the tracked send, and the
 * mount/unmount effect. The socket's own behaviour lives next door, one module
 * per seam:
 *
 *   ws-connection.ts            open a socket, wire its four events
 *   ws-open-handshake.ts        everything the client says on open
 *   ws-close-policy.ts          reconnect, and the auth-close proof
 *   ws-message-router.ts        parse + meter + route each frame
 *   ws-bypass-routes.ts         frames that must not wait for a frame
 *   ws-notice-routes.ts         toasts, upgrade warning, web control
 *   ws-flush-buffer.ts          rAF buffering -> one render per frame
 *   ws-subscription-watchers.ts keep the broker in step with the view
 *   ws-sync-protocol.ts         "did I miss anything?" on three clocks
 */
import { useCallback, useEffect, useRef } from 'react'
import { openWsConnection } from './ws-connection'
import { recordOut } from './ws-stats'
import {
  resetSubscribedConversations,
  watchAgentScope,
  watchConversationSubscriptions,
} from './ws-subscription-watchers'
import { startPeriodicSyncCheck } from './ws-sync-protocol'

/**
 * @param opts.conversationChannels When false, this socket NEVER subscribes to
 *   conversation transcript/events/tasks/bg_output channels. Standalone surfaces
 *   like the canvas popout only need the `canvas` channel, and pulling a busy
 *   conversation's multi-KB transcript entries would balloon the socket's send
 *   buffer into backpressure (megabytes), starving the canvas broadcasts that
 *   share it. Defaults true (the full dashboard).
 */
export function useWebSocket(opts?: { conversationChannels?: boolean }) {
  const subscribeConvChannels = opts?.conversationChannels !== false
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Tracked send: serializes + records byte count. Uses wsRef for subscription watchers.
  function send(msg: Record<string, unknown>) {
    const w = wsRef.current
    if (!w || w.readyState !== WebSocket.OPEN) return
    const json = JSON.stringify(msg)
    recordOut(json.length)
    w.send(json)
  }

  // Annotated so the self-reference in `reconnect` (the close policy's retry
  // re-enters connect) does not make TS infer the type circularly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - stable for the mount's lifetime, send only reads wsRef
  const connect = useCallback<() => void>(() => {
    openWsConnection({
      wsRef,
      reconnectTimeoutRef,
      send,
      reconnect: () => connect(),
      subscribeConvChannels,
    })
  }, [])

  // react-doctor-disable-next-line react-doctor/exhaustive-deps
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - runs once on mount, send only reads wsRef
  useEffect(() => {
    connect()

    resetSubscribedConversations()
    const unsubConversation = watchConversationSubscriptions(wsRef, send, subscribeConvChannels)
    const unsubAgent = watchAgentScope(wsRef, send)
    const stopSyncCheck = startPeriodicSyncCheck(() => wsRef.current?.readyState === WebSocket.OPEN, send)

    return () => {
      unsubConversation()
      unsubAgent()
      stopSyncCheck()
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [connect])

  return {
    isConnected: wsRef.current?.readyState === WebSocket.OPEN,
  }
}
