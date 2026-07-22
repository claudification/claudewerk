/**
 * voice-deepgram-protocol - the wire contract for the browser's DIRECT connection
 * to Deepgram live STT: the socket URL, the shape of the messages we read, and the
 * callback surface a session exposes. Split from voice-deepgram-direct so the
 * session module is only the state machine that drives them.
 */

const DG_LIVE_URL = 'wss://api.deepgram.com/v1/listen'

export interface TranscriptUpdate {
  /** This message's transcript text (interim or final). */
  transcript: string
  /** Deepgram marks this segment final. */
  isFinal: boolean
  /** Deepgram's end-of-utterance marker (endpoint or utterance_end). */
  speechFinal: boolean
  /** Full committed transcript so far (all is_final segments joined). */
  accumulated: string
}

/** Which leg failed, so the caller can pick honest user-facing wording. */
export type DirectFailure = 'token' | 'socket' | 'buffer'

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
  /** Flush Deepgram, resolve with the FULL final transcript, then close. */
  stop(): Promise<string>
  /** Hard teardown with no final (cancel). */
  abort(): void
}

export interface DeepgramDirectOptions {
  stream: MediaStream
  /** Token, or a promise for one. Recording begins before it resolves. */
  token: string | Promise<string>
  model: string
  callbacks: DeepgramDirectCallbacks
}

/** A Deepgram "Results" message (only the fields we read). */
export interface DeepgramResults {
  type: string
  is_final?: boolean
  speech_final?: boolean
  channel?: { alternatives?: Array<{ transcript?: string }> }
}

/**
 * Endpointing + finalization are DEEPGRAM's job via utterance_end_ms +
 * endpointing -- NOT ours. That is the entire point of going direct: the broker
 * relay and its custom VAD / force-Finalize (which kept falling behind real time
 * and shredding transcripts) are out of the loop.
 */
export function liveUrl(model: string): string {
  const params = new URLSearchParams({
    model,
    smart_format: 'true',
    interim_results: 'true',
    // Word-gap end-of-speech -- fires regardless of the noise floor, which is
    // exactly what the broker-relay path could not do on a raw mic.
    utterance_end_ms: '1000',
    endpointing: '300',
    punctuate: 'true',
    language: 'en',
  })
  return `${DG_LIVE_URL}?${params}`
}
