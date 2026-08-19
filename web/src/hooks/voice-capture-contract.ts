/**
 * voice-capture-contract - the shape every capture engine on the DIRECT
 * transport has, and the two helpers both of them need.
 *
 * Split out of voice-capture-engine so the container engine, the PCM engine and
 * the dispatcher can all import it without a cycle. Nothing here touches a
 * browser API, so it is also the only piece a test can reason about in isolation.
 *
 * NOT to be confused with voice-capture-shared.ts, which is the equivalent
 * contract for the LEGACY BROKER RELAY transport (base64 `voice_data` frames and
 * a different flush guarantee). Two transports, two contracts, on purpose.
 */

/** What the model requires. Not a user preference. */
export type CaptureKind = 'container' | 'pcm16'

/** Blob from a container muxer, ArrayBuffer of Int16 from the worklet. Both go
 *  on the wire verbatim -- WebSocket.send takes either. */
export type AudioChunk = Blob | ArrayBuffer

/** `label` is the MIME/encoding, for logs and the lag meter. */
export type ChunkHandler = (data: AudioChunk, label: string) => void

export interface CaptureEngine {
  /** MIME/encoding label, for logs and the lag meter. */
  readonly label: string
  /**
   * Stop capturing. Resolves only once the FINAL chunk has been delivered --
   * awaiting this is what keeps the tail of an utterance (up to a full second on
   * Safari, whose muxer emits ~1s fragments).
   */
  stop(): Promise<void>
  /** Tear down. Idempotent. */
  dispose(): void
}

/** If the engine's own done-event never lands, don't hang the release forever. */
const STOP_TIMEOUT_MS = 500

/**
 * Duck-typed on `byteLength` rather than `chunk instanceof ArrayBuffer`.
 * `instanceof` compares against the constructor of ONE realm, so a buffer that
 * arrived from another one -- a VM test context, a worker, an iframe -- answers
 * false and falls through to `.size`, which a buffer does not have. The result
 * is `undefined` bytes, silently, and the pre-roll ring then mis-accounts and
 * drops frames. Raw PCM has no framing, so a hole is mis-decoded rather than
 * rejected. Structural checks do not care which realm minted the object.
 */
export function chunkBytes(chunk: AudioChunk): number {
  return 'byteLength' in chunk ? chunk.byteLength : chunk.size
}

/**
 * One-shot settle with a timeout backstop. Both engines need it for the same
 * reason: the release of the push-to-talk key must never be able to hang on an
 * event the browser decided not to fire.
 */
export function stopGuard(begin: (done: () => void) => void): Promise<void> {
  return new Promise<void>(resolve => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    setTimeout(done, STOP_TIMEOUT_MS)
    begin(done)
  })
}
