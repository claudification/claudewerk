/**
 * Subscribe the live orb to OPEN QUESTIONS: when a conversation puts up an ask
 * or a dialog the user has to answer, the orb reads it out and waits.
 *
 * All the rules (what counts, one at a time, when to shut up, when to drop the
 * attempt) are in lib/voice-orb/dialog-prompt.ts; this is the store
 * subscription, the clock, and the write-through to the attempt bus that
 * `answer_dialog` reads. Mirrors use-orb-narration.ts / use-orb-channel.ts.
 */

import { useEffect } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { setDialogAttempt } from '@/lib/voice-orb/dialog-attempt'
import { decideDialogPrompt } from '@/lib/voice-orb/dialog-prompt'
import { openAnswerable } from '@/lib/voice-orb/dialog-targets'
import { useOrbSpeaker } from './use-orb-speaker'

/** Re-check even without a store change, so a prompt held back by the cooldown
 *  (or by the orb talking) still goes out a moment later. */
const TICK_MS = 2_000

export function useOrbDialog(active: boolean, orbState: string, announce: (note: string) => void): void {
  const speaker = useOrbSpeaker(orbState, announce)

  useEffect(() => {
    // No orb, no pending attempt -- a stale one would refuse the next answer.
    setDialogAttempt(null)
    if (!active) return
    let announcedKey: string | null = null
    let lastSpokeAt = 0

    const check = () => {
      const open = openAnswerable()
      const decision = decideDialogPrompt({
        open,
        announcedKey,
        orbState: speaker.orbState(),
        lastSpokeAt,
        now: Date.now(),
      })
      if (decision.announced !== announcedKey) {
        announcedKey = decision.announced
        const target = announcedKey ? open.find(d => d.key === announcedKey) : undefined
        setDialogAttempt(target ? { key: target.key, conversationId: target.conversationId } : null)
      }
      if (!decision.say) return
      lastSpokeAt = Date.now()
      speaker.announce(decision.say)
    }

    const unsub = useConversationsStore.subscribe(check)
    const interval = setInterval(check, TICK_MS)
    check()
    return () => {
      unsub()
      clearInterval(interval)
      setDialogAttempt(null)
    }
  }, [active, speaker])
}
