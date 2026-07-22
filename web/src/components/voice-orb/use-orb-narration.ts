/**
 * Subscribe the live orb to the fleet: when a conversation starts waiting on
 * the user, the orb says so unprompted.
 *
 * All the rules (what counts, how often, when to shut up) are in
 * lib/voice-orb/narration.ts; this is the store subscription and the clock.
 */

import { useEffect } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { selectConversations } from '@/lib/slim-conversation'
import { decideNarration, type NarratableConversation, newlyWaiting, snapshotStates } from '@/lib/voice-orb/narration'
import { useOrbSpeaker } from './use-orb-speaker'

function readFleet(): NarratableConversation[] {
  const byId = useConversationsStore.getState().conversationsById
  return selectConversations(byId)
    .filter(c => c.status !== 'ended')
    .map(c => ({ id: c.id, title: c.title ?? '', liveState: c.liveStatus?.state }))
}

export function useOrbNarration(active: boolean, orbState: string, announce: (note: string) => void): void {
  const speaker = useOrbSpeaker(orbState, announce)

  useEffect(() => {
    if (!active) return
    // Whatever was already waiting when the orb arrived is not news.
    let previous = snapshotStates(readFleet())
    let lastSpokeAt = 0

    return useConversationsStore.subscribe(() => {
      const fleet = readFleet()
      const waiting = newlyWaiting(previous, fleet)
      previous = snapshotStates(fleet)
      const decision = decideNarration({
        waiting,
        orbState: speaker.orbState(),
        lastSpokeAt,
        now: Date.now(),
      })
      if (!decision.say) return
      lastSpokeAt = Date.now()
      speaker.announce(decision.say)
    })
  }, [active, speaker])
}
