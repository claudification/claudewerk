/**
 * The TONE DIAL, panel side: cycle it, remember it, tell the user what they got.
 *
 * Kept eager and tiny (the palette command needs it without pulling the orb
 * chunk). The tone only reaches the model at MINT, so a change mid-session
 * applies on the next summon -- which is exactly the "restart me" case
 * `reload_yourself` covers.
 */

import { useConversationsStore } from '@/hooks/use-conversations'

export const VOICE_ORB_TONES = ['professional', 'snarky', 'homicidal', 'overkill'] as const
export type VoiceOrbTone = (typeof VOICE_ORB_TONES)[number]

const DEFAULT_TONE: VoiceOrbTone = 'snarky'

/** OpenAI's own bounds for `audio.output.speed` -- 1.6 is a 400 from the API. */
export const MIN_ORB_SPEED = 0.25
export const MAX_ORB_SPEED = 1.5

/** What each dial position gets you, in the orb's own register. */
const TONE_BLURB: Record<VoiceOrbTone, string> = {
  professional: 'Attitude off. Answers only.',
  snarky: 'The default. Dry contempt, correct data.',
  homicidal: 'Calmly menacing. Still does the work.',
  overkill: 'Operatic. Profanity permitted.',
}

export function currentTone(): VoiceOrbTone {
  const raw = useConversationsStore.getState().controlPanelPrefs.voiceOrbTone
  return VOICE_ORB_TONES.includes(raw as VoiceOrbTone) ? (raw as VoiceOrbTone) : DEFAULT_TONE
}

export function nextTone(tone: VoiceOrbTone): VoiceOrbTone {
  const i = VOICE_ORB_TONES.indexOf(tone)
  return VOICE_ORB_TONES[(i + 1) % VOICE_ORB_TONES.length] as VoiceOrbTone
}

/** Cycle the dial and return what it landed on. */
export function cycleVoiceOrbTone(): VoiceOrbTone {
  const tone = nextTone(currentTone())
  useConversationsStore.getState().updateControlPanelPrefs({ voiceOrbTone: tone })
  window.dispatchEvent(
    new CustomEvent('rclaude-toast', {
      detail: {
        title: `Voice orb tone: ${tone}`,
        body: `${TONE_BLURB[tone]} Takes effect on the orb's next summon.`,
      },
    }),
  )
  return tone
}
