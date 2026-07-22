/**
 * voice-prewarm - warm everything a push-to-talk press needs, so the press pays
 * for none of it.
 *
 * Two independent costs sit in front of the first transcribed word: opening the
 * mic device (getUserMedia, ~2-3s cold on macOS) and minting the Deepgram token
 * (browser -> broker -> Deepgram grant). They are warmed separately because they
 * are not alike: the mic is a physical device that blips Bluetooth and must be
 * released on idle, while a token is a string with a TTL and costs nothing to
 * hold. Only the token warms unconditionally.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { prewarmDeepgramToken } from '@/hooks/voice-deepgram-token'
import { prewarmMicStream } from '@/hooks/voice-mic-stream'

function directPathEnabled(): boolean {
  // Optional-chained on purpose: this runs from mount effects, and a prewarm is
  // a pure optimisation -- it must never be the thing that throws in render.
  return useConversationsStore.getState().controlPanelPrefs?.voiceDirectToDeepgram === true
}

/** Pre-mint the Deepgram token when the direct path is on. No device access. */
export function prewarmVoiceTransport(): void {
  if (directPathEnabled()) prewarmDeepgramToken()
}

/** Warm the mic device AND the transport. Call where a mic warm is already wanted. */
export function prewarmVoice(): void {
  prewarmMicStream()
  prewarmVoiceTransport()
}
