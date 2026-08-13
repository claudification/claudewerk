/**
 * Keep this browser's status subscriptions alive across reconnects.
 *
 * The broker forgets watches when the socket closes (they are socket-scoped on
 * purpose -- see broker/desk/orb-status-watch.ts), so somebody has to restate
 * them. `connectSeq` bumps on every WS (re)connect, which makes it the exact
 * trigger: re-run and re-assert whatever lib/voice-orb/orb-watches.ts remembers.
 * Same shape as `resubscribeAgentScopes`, which solves this for agent channels.
 *
 * GATED ON THE ORB BEING LIVE. Nothing else consumes a watched status, so an
 * un-summoned panel holds no subscriptions and the broker does no work for it.
 * Dismissing releases them; re-summoning re-asserts from localStorage, so the
 * user loses nothing by closing the orb between questions.
 */

import { useEffect } from 'react'
import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { reassertOrbWatches } from '@/lib/voice-orb/orb-watches'

const send = (msg: { type: string; patterns: string[] }) => {
  wsSend(msg.type, { patterns: msg.patterns })
}

export function useOrbWatches(live: boolean): void {
  const connectSeq = useConversationsStore(s => s.connectSeq)
  const isConnected = useConversationsStore(s => s.isConnected)

  useEffect(() => {
    if (!live || !isConnected) return
    reassertOrbWatches(send)
    return () => {
      // Release on dismiss / disconnect. Best-effort: if the socket is already
      // gone the broker dropped them on close anyway, which is the whole point.
      send({ type: 'voice_watch_assert', patterns: [] })
    }
  }, [live, isConnected, connectSeq])
}
