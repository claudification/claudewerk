/**
 * voice-stt-protocol - the wire contract between the browser and the stt-proxy
 * Worker: the socket URL, the frames it sends back, and the callback surface a
 * session exposes.
 *
 * WHY A WORKER AND NOT THE VENDOR DIRECTLY. Dictation used to open a socket
 * straight to api.deepgram.com, which is a single US datacenter -- 270ms RTT
 * from Thailand, and measurably 8.5-11.8 SECONDS behind real time on two of
 * three runs. The same models on Cloudflare Workers AI held flat. Workers AI
 * authenticates with an Authorization HEADER, which a browser cannot set on a
 * WebSocket, so our own Worker terminates the browser socket at the nearest
 * Cloudflare colo and speaks to the model on our behalf.
 *
 * THE MODEL IS INVISIBLE FROM HERE. The Worker normalises flux's turn-based
 * events and nova-3's Deepgram-v1 segments into the SAME frame, so this file
 * never learns which one answered. See workers/stt-proxy/src/normalize.ts.
 */

import { type CaptureKind, PCM_SAMPLE_RATE } from '@/hooks/voice-capture-engine'

/** Same-origin by default so a deploy cannot leave this pointing at a stale host. */
const STT_HOST = import.meta.env.VITE_STT_HOST ?? 'stt.frst.dev'

export interface TranscriptUpdate {
  /**
   * The FULL text of the segment/turn in flight -- never a fragment to append.
   * `committed` is everything finished before it, so a renderer shows
   * `committed + transcript` and appends nothing itself. That one rule is what
   * makes flux's cumulative transcript and nova-3's deltas interchangeable.
   */
  transcript: string
  /** This segment/turn is complete. NOT a signal to submit. */
  isFinal: boolean
  /** Everything already finalised. Render `accumulated + transcript`. */
  accumulated: string
  /** flux only: live confidence the speaker has finished. For tuning/UI. */
  endOfTurnConfidence?: number
}

/** Which leg failed, so the caller can pick honest user-facing wording. */
export type DirectFailure = 'token' | 'socket' | 'buffer' | 'capture'

/** Pre-open audio handed to the socket the moment it opened. */
export interface FlushStats {
  chunks: number
  bytes: number
}

export interface DeepgramDirectCallbacks {
  onTranscript(update: TranscriptUpdate): void
  /** Socket live; `flushed` is the pre-open audio just handed over. */
  onOpen?: (flushed: FlushStats) => void
  onError: (message: string, kind: DirectFailure) => void
}

export interface DeepgramDirectSession {
  /** Flush upstream, resolve with the FULL final transcript, then close. */
  stop(): Promise<string>
  /** Hard teardown with no final (cancel). */
  abort(): void
}

export interface DeepgramDirectOptions {
  stream: MediaStream
  /** Token, or a promise for one. Recording begins before it resolves. */
  token: string | Promise<string>
  /** 'flux' (default) or 'nova-3'. The Worker owns what each one means; the
   *  browser only has to agree on what to capture with (voice-stt-models). */
  model: string
  /** Override the capture sample rate. Defaults to the worklet's 16 kHz. */
  sampleRate?: number
  /** End-of-turn tuning, forwarded verbatim; the Worker allowlists them. */
  tuning?: Record<string, string>
  callbacks: DeepgramDirectCallbacks
}

/** A frame from the Worker. One shape for every model. */
export interface SttFrame {
  type: 'transcript' | 'done' | 'error'
  text?: string
  committed?: string
  final?: boolean
  audioEndMs?: number
  endOfTurnConfidence?: number
  error?: string
  reason?: string
}

/**
 * Endpointing and turn detection are the MODEL's job, configured server-side.
 * That is the entire point of this path: the broker relay and its hand-rolled
 * VAD / force-Finalize (which kept falling behind real time and shredding
 * transcripts) are out of the loop.
 */
export function liveUrl(
  model: string,
  token: string,
  opts: { capture: CaptureKind; sampleRate?: number; tuning?: Record<string, string> },
) {
  const params = new URLSearchParams({ t: token, model })
  // RAW PCM HAS NO CONTAINER TO SNIFF. Declaring it is not an optimisation: an
  // undeclared PCM stream is read as a broken container and yields NOTHING -- no
  // error, no transcript. This is also what lets nova-3 accept our PCM, so the
  // capture engine and the model can be chosen independently.
  if (opts.capture === 'pcm16') {
    params.set('encoding', 'linear16')
    params.set('sample_rate', String(opts.sampleRate ?? PCM_SAMPLE_RATE))
  } else if (opts.sampleRate) {
    params.set('sample_rate', String(opts.sampleRate))
  }
  for (const [key, value] of Object.entries(opts.tuning ?? {})) {
    if (value) params.set(key, value)
  }
  return `wss://${STT_HOST}/listen?${params}`
}
