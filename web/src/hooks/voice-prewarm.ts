/**
 * voice-prewarm - warm everything a push-to-talk press needs, so the press pays
 * for none of it.
 *
 * Three costs sit in front of the first transcribed word, and only one of them
 * is the microphone. MEASURED on a real cold press (2026-08-18, 1388ms lost in
 * total): getUserMedia 991ms, the audio graph 316ms, the chord grace window
 * 73ms; the token was already warm at 6ms.
 *
 * They are warmed separately because they are not alike. The mic is a physical
 * device that blips Bluetooth, lights an indicator and must be released on idle,
 * so warming it is opt-in. A token is a string with a TTL, and an AudioContext
 * is a suspended handle -- both cost nothing to hold and need no permission, so
 * both warm unconditionally.
 */

import { prewarmPcmContext } from '@/hooks/voice-capture-pcm'
import { prewarmMicStream } from '@/hooks/voice-mic-stream'
import { prewarmSttToken } from '@/hooks/voice-stt-token'

/**
 * Everything a press needs that is NOT the microphone: the STT token and the
 * audio graph's stream-independent half (AudioContext + worklet module, measured
 * at 316ms on a real cold press). Neither touches a device, asks a permission or
 * lights an indicator, so this is always safe to call.
 */
export function prewarmVoiceTransport(): void {
  prewarmSttToken()
  prewarmPcmContext()
}

/** Warm the mic device AND the transport. Call where a mic warm is already wanted. */
export function prewarmVoice(): void {
  prewarmMicStream()
  prewarmVoiceTransport()
}
