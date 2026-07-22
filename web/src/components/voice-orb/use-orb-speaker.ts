/**
 * The live handle every orb subscription needs: what the orb is doing RIGHT NOW,
 * and a way to make it speak.
 *
 * All three subscriptions (narration, channel, dialog) set up one long-lived
 * effect keyed on `active` and then read `orbState` / `announce` from inside it
 * on every tick. Both props change constantly, so the effect cannot depend on
 * them without tearing the subscription down several times a second -- hence
 * refs. The handle itself is stable, so it is safe to close over.
 */

import { useRef } from 'react'

export interface OrbSpeaker {
  /** The orb's state as of this render -- 'speaking'/'thinking' means shut up. */
  orbState(): string
  /** Make the orb say something unprompted, in persona. */
  announce(note: string): void
}

export function useOrbSpeaker(orbState: string, announce: (note: string) => void): OrbSpeaker {
  const stateRef = useRef(orbState)
  stateRef.current = orbState
  const announceRef = useRef(announce)
  announceRef.current = announce

  const speaker = useRef<OrbSpeaker | null>(null)
  speaker.current ??= { orbState: () => stateRef.current, announce: note => announceRef.current(note) }
  return speaker.current
}
