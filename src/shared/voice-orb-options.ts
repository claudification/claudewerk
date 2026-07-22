/**
 * The voice orb's user-facing OPTIONS -- shared, because both halves need the
 * same lists: the control panel renders the pickers, the broker validates what
 * comes back off the wire and bakes it into the minted session.
 *
 * Every value here was verified against the live OpenAI API (2026-07-22):
 * these ten voices mint, `nova` is a 400, and speed above 1.5 is a 400.
 */

export const VOICE_ORB_TONES = ['professional', 'snarky', 'homicidal', 'overkill'] as const
export type VoiceOrbTone = (typeof VOICE_ORB_TONES)[number]
export const DEFAULT_VOICE_ORB_TONE: VoiceOrbTone = 'snarky'

export const VOICE_ORB_VOICES = [
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
] as const
export type VoiceOrbVoice = (typeof VOICE_ORB_VOICES)[number]
export const DEFAULT_VOICE_ORB_VOICE: VoiceOrbVoice = 'marin'

/** OpenAI's own bounds for `audio.output.speed`. */
export const MIN_VOICE_ORB_SPEED = 0.25
export const MAX_VOICE_ORB_SPEED = 1.5
export const DEFAULT_VOICE_ORB_SPEED = 1.3

/** Narrow an untrusted value (wire input, stored pref) to a tone. */
export function asVoiceOrbTone(raw: unknown): VoiceOrbTone {
  return VOICE_ORB_TONES.includes(raw as VoiceOrbTone) ? (raw as VoiceOrbTone) : DEFAULT_VOICE_ORB_TONE
}

/** Narrow an untrusted value to a voice the model will actually accept. */
export function asVoiceOrbVoice(raw: unknown): VoiceOrbVoice {
  return VOICE_ORB_VOICES.includes(raw as VoiceOrbVoice) ? (raw as VoiceOrbVoice) : DEFAULT_VOICE_ORB_VOICE
}

/** Clamp an untrusted speed into the API's range; junk falls back to default. */
export function clampVoiceOrbSpeed(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_VOICE_ORB_SPEED
  return Math.min(MAX_VOICE_ORB_SPEED, Math.max(MIN_VOICE_ORB_SPEED, n))
}
