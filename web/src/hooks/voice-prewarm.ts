/**
 * voice-prewarm - warm everything a push-to-talk press needs, so the press pays
 * for none of it.
 *
 * Two independent costs sit in front of the first transcribed word: opening the
 * mic device (getUserMedia, ~2-3s cold on macOS) and minting the STT token. They
 * are warmed separately because they are not alike: the mic is a physical device
 * that blips Bluetooth and must be released on idle, while a token is a string
 * with a TTL and costs nothing to hold. Only the token warms unconditionally.
 */

import { prewarmMicStream } from '@/hooks/voice-mic-stream'
import { prewarmSttToken } from '@/hooks/voice-stt-token'

/** Pre-mint the STT token. No device access, so it is always safe to call. */
export function prewarmVoiceTransport(): void {
  prewarmSttToken()
}

/** Warm the mic device AND the transport. Call where a mic warm is already wanted. */
export function prewarmVoice(): void {
  prewarmMicStream()
  prewarmVoiceTransport()
}
