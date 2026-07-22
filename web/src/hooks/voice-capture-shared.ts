/**
 * voice-capture-shared - the mic-capture contract + its base64 helper.
 *
 * One engine: voice-mediarecorder-capture (MediaRecorder -> webm/opus or Safari
 * audio/mp4 container, handed to Deepgram for native endpointing). A raw-PCM
 * AudioWorklet engine also lived here; it was deleted after it regressed real
 * dictation. use-voice-recording drives the engine through this handle.
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
