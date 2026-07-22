/**
 * The ORB itself -- the orb IS the presence, not a chat window. Pure visual:
 * it takes a state and renders it. No session, no store, no side effects.
 *
 * Built from layered CSS (no Rive, no canvas): a core that breathes, a halo
 * that reacts, and a ring that spins while the orb is thinking. `level` (0..1)
 * is live audio energy -- passed in by the host so the same component works
 * silent (P0) and audio-reactive (P3) without a rewrite.
 */

import { cn } from '@/lib/utils'
import './voice-orb.css'

export type OrbState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'asleep'

const LABEL: Record<OrbState, string> = {
  connecting: 'waking up',
  listening: 'listening',
  thinking: 'working on it',
  speaking: 'talking',
  asleep: 'dozing',
}

export function VoiceOrb({
  state,
  level = 0,
  className,
}: {
  state: OrbState
  /** Live audio energy, 0..1. Drives the halo's swell. */
  level?: number
  className?: string
}) {
  // Clamp defensively: an AnalyserNode can hand back >1 on a loud transient,
  // and a runaway scale would blow the orb past its own hit area.
  const swell = 1 + Math.min(1, Math.max(0, level)) * 0.35
  return (
    <span
      className={cn('voice-orb', `voice-orb--${state}`, className)}
      data-state={state}
      role="img"
      aria-label={`Voice orb -- ${LABEL[state]}`}
    >
      <span className="voice-orb__halo" style={{ transform: `scale(${swell})` }} />
      <span className="voice-orb__core" />
      <span className="voice-orb__sheen" />
      {/* The pupil dilates with whoever is talking -- the menace lives here. */}
      <span className="voice-orb__iris" style={{ transform: `scale(${1 + (swell - 1) * 0.8})` }} />
      <span className="voice-orb__ring" />
    </span>
  )
}
