/**
 * Owns the broker `canvas` room lifecycle for one canvas, split out of
 * useCanvasCollab so each hook has a single responsibility.
 *
 * The join MUST wait for a LIVE socket: useWebSocket() sets store.ws only in its
 * onopen, so a join fired on mount races ahead of the connection -- wsSend()
 * drops it and nothing retries, leaving the peer out of the room (no cursors, its
 * own deltas ignored broker-side). Gating on isConnected + depending on connectSeq
 * fixes that AND makes it resilient: a broker restart wipes every room, and every
 * client auto-rejoins on the reconnect that bumps connectSeq.
 */

import { useEffect } from 'react'
import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { registerCanvasListener, unregisterCanvasListener } from './canvas-collab-bus'

/** Stamped on every canvas_join so the BROKER LOG proves which client build is
 *  talking -- a popped-out canvas window has no console, so this is the only way
 *  to tell "new bundle, joining" from "stale cache, old code". Bump on contract
 *  changes. */
const JOIN_CLIENT_MARK = 'join-on-connect-1'

type Inbound = Record<string, (m: Record<string, unknown>) => void>

export function useCanvasRoom(
  canvasId: string | null,
  enabled: boolean,
  name: string | undefined,
  handlers: Inbound,
  onLeave: () => void,
): void {
  const isConnected = useConversationsStore(s => s.isConnected)
  const connectSeq = useConversationsStore(s => s.connectSeq)

  useEffect(() => {
    if (!enabled || !canvasId || !isConnected) return
    registerCanvasListener(canvasId, msg => handlers[msg.type as string]?.(msg))
    wsSend('canvas_join', { canvasId, name, client: JOIN_CLIENT_MARK })
    return () => {
      wsSend('canvas_leave', { canvasId })
      unregisterCanvasListener(canvasId)
      onLeave()
    }
  }, [canvasId, enabled, name, isConnected, connectSeq, handlers, onLeave])
}
