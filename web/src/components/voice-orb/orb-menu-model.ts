/**
 * The orb menu's pure bits: the speaking-rate steps, how an arbitrary stored
 * rate maps onto them, and the one-line labels for every voice and tone.
 *
 * The Settings slider is continuous (0.05 steps) and this menu is a short list,
 * so "which row is ticked" is a real question with a wrong answer -- 1.28 must
 * tick 1.3x, not nothing. Pure + tested so the menu component stays dumb.
 */

import {
  MAX_VOICE_ORB_SPEED,
  MIN_VOICE_ORB_SPEED,
  type VoiceOrbTone,
  type VoiceOrbVoice,
} from '@shared/voice-orb-options'

/** The rates worth one tap. Slow enough to follow, up to the API's own ceiling. */
export const ORB_SPEED_STEPS = [0.9, 1.0, 1.15, 1.3, MAX_VOICE_ORB_SPEED] as const

/**
 * The one-line blurb per VOICE and per TONE, shared by the orb menu (submenu
 * rows) and the Settings pickers so the two surfaces can never label the same
 * option differently. Every voice here was verified to mint against the live
 * OpenAI API (2026-07-22).
 */
export const VOICE_LABEL: Record<VoiceOrbVoice, string> = {
  marin: 'marin -- the default',
  cedar: 'cedar -- warm, low',
  alloy: 'alloy -- neutral',
  ash: 'ash -- dry, gravelly',
  ballad: 'ballad -- lilting',
  coral: 'coral -- bright',
  echo: 'echo -- flat, clipped',
  sage: 'sage -- calm',
  shimmer: 'shimmer -- airy',
  verse: 'verse -- theatrical',
}

export const TONE_LABEL: Record<VoiceOrbTone, string> = {
  professional: 'Professional -- attitude off',
  snarky: 'Snarky -- the default',
  homicidal: 'Homicidal -- calmly menacing',
  overkill: 'Overkill -- operatic, swears',
}

export function speedLabel(speed: number): string {
  // Number's own formatting drops the trailing zeros for free: 1 -> "1x".
  return `${Number(speed)}x`
}

/** The step a stored rate ticks -- the closest one, ties going slower. */
export function nearestSpeedStep(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return ORB_SPEED_STEPS[3]
  const clamped = Math.min(MAX_VOICE_ORB_SPEED, Math.max(MIN_VOICE_ORB_SPEED, n))
  let best = ORB_SPEED_STEPS[0] as number
  for (const step of ORB_SPEED_STEPS) {
    if (Math.abs(step - clamped) < Math.abs(best - clamped)) best = step
  }
  return best
}
