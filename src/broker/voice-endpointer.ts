/**
 * voice-endpointer - decides when to force Deepgram to close the current segment.
 *
 * WHY IT EXISTS (measured 2026-07-21/22): the mic is opened RAW -- no echo
 * cancellation, no noise suppression -- because enabling them retriggered a
 * CoreAudio HAL reconfigure that ducked the input (see voice-mic-stream.ts). A
 * raw mic has a constant noise floor, so Deepgram's VAD often never sees silence,
 * so `endpointing:500` never fires, so the utterance never closes. With the
 * segment open forever Deepgram re-decodes an ever-growing interim window and
 * falls below real time -- asrLag climbed 0.7s -> 8.9s over 27s of speech. That
 * is the "fine for a couple words, then unbearable" lag. Deepgram's own remedy is
 * the Finalize message (https://developers.deepgram.com/docs/finalize).
 *
 * WHY IT WAS REWRITTEN (2026-07-22): the first version drove Finalize off a bare
 * wall clock, gated on "did audioBytes grow since the last tick" as a proxy for
 * "is the user talking". That proxy is DEAD: the client streams raw PCM
 * unconditionally at ~20 chunks/sec, silence included, so audioBytes ALWAYS grows
 * and the gate is always open. Result: a Finalize every ~2.5s from mic-open to
 * mic-close, landing mid-word, throwing away the decode context that fixes
 * homophones -- ~10 cut points in a 30s dictation. Confirmed in broker logs:
 * finals at audioPos 2.95s / 5.40s / 8.40s / 10.90s, `fromFinalize=true`, some
 * with `chars=0` (a Finalize fired into a silent gap).
 *
 * So we do our own VAD on the PCM we already have in hand, and cut at PAUSES:
 *   - soft cap: once the segment has been open past SOFT_FINALIZE_MS, close it at
 *     the FIRST pause. Word boundary, no context lost mid-word.
 *   - hard cap: if the user never pauses, HARD_FINALIZE_MS bounds the decode
 *     window anyway. One rare mid-word cut instead of one every 2.5s.
 *   - a segment with no speech in it is never closed (that was the chars=0 churn).
 *
 * This module is the pure decision. The socket send lives in voice-stream.ts.
 */

/** Once open this long, the segment closes at the next pause. */
export const SOFT_FINALIZE_MS = 2500
/** Absolute ceiling on an open segment, pause or not -- bounds Deepgram's decode window. */
export const HARD_FINALIZE_MS = 8000
/** Non-speech this long counts as a pause worth cutting on (~a comma's worth). */
export const PAUSE_MS = 280

/** Speech must exceed the tracked noise floor by this factor (~8 dB). */
const SPEECH_OVER_FLOOR = 2.5
/** ...and clear this absolute RMS (~-54 dBFS), so a dead-quiet room can't make
 *  its own hiss "speech" by proportion alone. */
const SPEECH_FLOOR_MIN = 0.002
/**
 * Noise floor = MINIMUM STATISTICS: the quietest chunk seen in the trailing
 * window becomes the floor. An EMA cannot work here (tried, test caught it): in a
 * loud room the ambient itself reads as speech, so an "only track on non-speech"
 * EMA never converges and the floor stays pinned at its minimum forever.
 * The minimum needs no speech/noise decision to update, so it has no such
 * bootstrap problem. At 50ms resolution real speech dips near ambient between
 * words many times per window, so the minimum lands close to true ambient even
 * mid-sentence; those 1-2 chunk dips can't be mistaken for a pause because
 * PAUSE_MS demands ~6 consecutive quiet chunks.
 */
const FLOOR_WINDOW_MS = 4000
/** Never let the tracked floor collapse to 0 (digital silence) -- the threshold
 *  would then be SPEECH_FLOOR_MIN alone, which is the intended backstop anyway. */
const FLOOR_MIN = 0.0005

export interface EndpointerState {
  /** Wall-clock ms of the last segment close -- natural (speech_final) or forced. */
  lastCloseAt: number
  /** Wall-clock ms of the last chunk classified as speech (0 = none yet). */
  lastSpeechAt: number
  /** Tracked ambient RMS, 0..1. */
  noiseFloor: number
  /** Quietest chunk seen in the window that is still filling. */
  windowMin: number
  /** Wall-clock ms the current floor window opened. */
  windowStartAt: number
  /** True once speech has been seen since `lastCloseAt` -- an empty segment is
   *  never worth a Finalize. */
  speechSinceClose: boolean
}

export function createEndpointerState(now: number): EndpointerState {
  return {
    lastCloseAt: now,
    lastSpeechAt: 0,
    noiseFloor: FLOOR_MIN,
    windowMin: Number.POSITIVE_INFINITY,
    windowStartAt: now,
    speechSinceClose: false,
  }
}

/**
 * RMS of a linear16 (signed 16-bit LE) buffer, normalized to 0..1.
 * An odd trailing byte is ignored; an empty buffer is silence.
 */
export function rmsFromLinear16(bytes: Uint8Array): number {
  const samples = bytes.length >> 1
  if (samples === 0) return 0
  let sumSquares = 0
  for (let i = 0; i < samples; i++) {
    // Little-endian signed 16-bit, without allocating a DataView per chunk.
    const raw = (bytes[i * 2 + 1] << 8) | bytes[i * 2]
    const sample = raw >= 0x8000 ? raw - 0x10000 : raw
    sumSquares += sample * sample
  }
  return Math.sqrt(sumSquares / samples) / 32768
}

export interface EndpointerChunk {
  now: number
  /** Chunk RMS (0..1). Meaningless unless `pcm` is true. */
  rms: number
  /** False when the payload is a container (webm/opus) we cannot measure --
   *  every chunk then counts as speech, so only the hard cap applies. */
  pcm: boolean
  /** dgWs is OPEN and the session is live (not stopping, has seen audio). */
  active: boolean
}

export type FinalizeReason = 'pause' | 'hard-cap'

export interface EndpointerDecision {
  finalize: FinalizeReason | null
  next: EndpointerState
  /** Diagnostics for the caller's log line -- never used for control flow. */
  speech: boolean
  openMs: number
}

/**
 * Fold one chunk into the floor estimate. A quieter-than-floor chunk drops the
 * floor immediately (a room that just went quiet shouldn't wait out the window);
 * a rise only lands when the window closes, carrying that window's minimum.
 */
type FloorState = Pick<EndpointerState, 'noiseFloor' | 'windowMin' | 'windowStartAt'>

function trackFloor(state: EndpointerState, chunk: EndpointerChunk): FloorState {
  const { noiseFloor, windowMin: prevMin, windowStartAt } = state
  // Container audio has no measurable level -- leave the estimate untouched.
  if (!chunk.pcm) return { noiseFloor, windowMin: prevMin, windowStartAt }

  const { now, rms } = chunk
  const windowMin = Math.min(prevMin, rms)
  if (now - state.windowStartAt < FLOOR_WINDOW_MS) {
    return {
      noiseFloor: Math.max(Math.min(state.noiseFloor, rms), FLOOR_MIN),
      windowMin,
      windowStartAt: state.windowStartAt,
    }
  }
  return {
    noiseFloor: Math.max(windowMin, FLOOR_MIN),
    windowMin: rms,
    windowStartAt: now,
  }
}

function decideFinalize(state: EndpointerState, now: number, openMs: number, speech: boolean): FinalizeReason | null {
  if (!state.speechSinceClose) return null
  if (openMs >= HARD_FINALIZE_MS) return 'hard-cap'
  if (openMs < SOFT_FINALIZE_MS) return null
  const pausedFor = speech ? 0 : now - state.lastSpeechAt
  return pausedFor >= PAUSE_MS ? 'pause' : null
}

/**
 * Feed one audio chunk and decide whether to Finalize.
 *
 * Order matters:
 * - inactive socket: hold the clock at `now` so a resume gets a full window.
 * - classify against the CURRENT floor, then fold the chunk into the floor
 *   estimate (order matters: the floor must not be moved by the chunk it judges).
 * - close at a pause once past the soft cap, or unconditionally past the hard
 *   cap -- but only if this segment actually contains speech.
 */
export function evaluateEndpointer(state: EndpointerState, chunk: EndpointerChunk): EndpointerDecision {
  if (!chunk.active) {
    return { finalize: null, speech: false, openMs: 0, next: { ...state, lastCloseAt: chunk.now } }
  }

  const threshold = Math.max(state.noiseFloor * SPEECH_OVER_FLOOR, SPEECH_FLOOR_MIN)
  const speech = chunk.pcm ? chunk.rms > threshold : true

  const next: EndpointerState = {
    lastCloseAt: state.lastCloseAt,
    lastSpeechAt: speech ? chunk.now : state.lastSpeechAt,
    ...trackFloor(state, chunk),
    speechSinceClose: state.speechSinceClose || speech,
  }

  const openMs = chunk.now - state.lastCloseAt
  const finalize = decideFinalize(next, chunk.now, openMs, speech)
  if (!finalize) return { finalize: null, speech, openMs, next }
  return { finalize, speech, openMs, next: { ...next, lastCloseAt: chunk.now, speechSinceClose: false } }
}

/** Called when Deepgram closes a segment on its own (speech_final=true): the
 *  clock restarts from that natural close, so a well-behaved VAD session never
 *  triggers a forced Finalize at all. */
export function noteNaturalClose(state: EndpointerState, now: number): EndpointerState {
  return { ...state, lastCloseAt: now, speechSinceClose: false }
}
