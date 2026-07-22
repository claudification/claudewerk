/**
 * The TONE DIAL, panel side: cycle it, remember it, tell the user what they got.
 *
 * Kept eager and tiny (the palette command needs it without pulling the orb
 * chunk). The tone only reaches the model at MINT, so a change mid-session
 * applies on the next summon -- which is exactly the "restart me" case
 * `reload_yourself` covers.
 */

import {
  asVoiceOrbTone,
  DEFAULT_VOICE_ORB_TONE,
  MAX_VOICE_ORB_SPEED,
  MIN_VOICE_ORB_SPEED,
  VOICE_ORB_TONES,
  type VoiceOrbTone,
} from '@shared/voice-orb-options'
import { useConversationsStore } from '@/hooks/use-conversations'

export { VOICE_ORB_TONES, type VoiceOrbTone }
export const MIN_ORB_SPEED = MIN_VOICE_ORB_SPEED
export const MAX_ORB_SPEED = MAX_VOICE_ORB_SPEED

/** What each dial position gets you, in the orb's own register. */
const TONE_BLURB: Record<VoiceOrbTone, string> = {
  professional: 'Attitude off. Answers only.',
  snarky: 'The default. Dry contempt, correct data.',
  homicidal: 'Calmly menacing. Still does the work.',
  overkill: 'Bar-room opera. Profanity permitted.',
}

export function currentTone(): VoiceOrbTone {
  return asVoiceOrbTone(useConversationsStore.getState().controlPanelPrefs.voiceOrbTone)
}

export function nextTone(tone: VoiceOrbTone): VoiceOrbTone {
  const i = VOICE_ORB_TONES.indexOf(tone)
  return VOICE_ORB_TONES[(i + 1) % VOICE_ORB_TONES.length] ?? DEFAULT_VOICE_ORB_TONE
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
