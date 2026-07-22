/**
 * Drain the orb channel queue to the live orb: when a conversation has sent a
 * line addressed to the orb, speak it -- newest-first, one per floor, never over
 * the orb's own sentence.
 *
 * All the policy (what to say, when to shut up, drop-stale) is in
 * lib/voice-orb/orb-channel.ts; the queue itself is the module singleton in
 * orb-channel-bus.ts (so it survives while the orb is away). This is just the
 * clock + the subscription, mirroring use-orb-narration.ts.
 */

import { useEffect, useRef } from 'react'
import { decideOrbChannel } from '@/lib/voice-orb/orb-channel'
import {
  getOrbChannelQueue,
  setOrbChannelDraining,
  setOrbChannelQueue,
  subscribeOrbChannel,
} from '@/lib/voice-orb/orb-channel-bus'

/** Re-check the queue this often so a cooldown expiry or a freshly-stale line is
 *  acted on even without a new arrival. */
const TICK_MS = 2_000

export function useOrbChannel(active: boolean, orbState: string, announce: (note: string) => void): void {
  const orbStateRef = useRef(orbState)
  orbStateRef.current = orbState
  const announceRef = useRef(announce)
  announceRef.current = announce

  useEffect(() => {
    setOrbChannelDraining(active)
    if (!active) return
    let lastSpokeAt = 0

    const drain = () => {
      const decision = decideOrbChannel({
        queue: getOrbChannelQueue(),
        orbState: orbStateRef.current,
        lastSpokeAt,
        now: Date.now(),
      })
      // Always write back: prunes stale, and removes the spoken line when we spoke.
      setOrbChannelQueue(decision.remaining)
      if (!decision.say) return
      lastSpokeAt = Date.now()
      announceRef.current(decision.say)
    }

    const unsub = subscribeOrbChannel(drain)
    const interval = setInterval(drain, TICK_MS)
    drain() // flush anything that queued while the orb was away
    return () => {
      unsub()
      clearInterval(interval)
      setOrbChannelDraining(false)
    }
  }, [active])
}
