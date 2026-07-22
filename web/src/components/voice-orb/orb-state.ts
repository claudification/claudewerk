/**
 * Session state -> what the ORB shows. Pure, so the mapping is testable without
 * mounting the host: muted and dozing both read as "asleep" (the orb is present
 * but not listening), and anything the orb can't be mid-turn falls back to
 * listening rather than blanking out.
 */

import type { OrbState } from './voice-orb'

const DIRECT = new Set(['speaking', 'thinking', 'connecting'])

export function toOrbState(sessionState: string, muted: boolean, dozing: boolean): OrbState {
  if (muted || dozing) return 'asleep'
  return DIRECT.has(sessionState) ? (sessionState as OrbState) : 'listening'
}
