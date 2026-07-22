/**
 * voice-capture-shared - the contract every mic-capture engine implements, plus
 * the one helper they both need.
 *
 * Two engines exist: voice-pcm-capture (AudioWorklet -> linear16/16k, added to
 * kill a Safari lag) and voice-mediarecorder-capture (MediaRecorder -> webm/opus
 * or audio/mp4 container, the original path). use-voice-recording picks one at
 * start() time behind the `voiceCaptureEngine` pref and drives it through this
 * handle, so the rest of the hook is engine-agnostic.
 */

/** What use-voice-recording holds and drives, regardless of capture engine. */
export interface CaptureHandle {
  /** Drain any buffered audio; resolves once the final chunk has been posted. */
  flush(): Promise<void>
  /** Tear the capture down. Idempotent. */
  stop(): void
}

export interface StartCaptureOptions {
  /** Fires once per audio chunk, base64-encoded, ready for voice_data. */
  onChunk: (base64: string) => void
  /** Optional per-chunk failure log hook (encode errors are near-impossible but logged). */
  onError?: (err: unknown) => void
}

/**
 * Base64-encode a buffer WITHOUT the spread operator. The naive
 * `btoa(String.fromCharCode(...u8))` spreads the whole Uint8Array as
 * Function.prototype.apply arguments -- on Safari/iOS with large chunks this
 * hits the engine's argument-count limit and throws RangeError silently.
 */
export function bufferToBase64(buffer: ArrayBuffer): string {
  const u8 = new Uint8Array(buffer)
  const CHUNK = 0x8000 // 32 KiB per fromCharCode call
  const parts: string[] = []
  for (let i = 0; i < u8.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK) as unknown as number[]))
  }
  return btoa(parts.join(''))
}
