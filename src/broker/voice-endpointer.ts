/**
 * voice-endpointer - forces Deepgram to close the current segment when its own
 * VAD-based endpointing won't.
 *
 * WHY (measured 2026-07-21/22, not guessed): the mic is opened RAW -- no echo
 * cancellation, no noise suppression -- because enabling them retriggered a
 * CoreAudio HAL reconfigure that ducked the input (see voice-mic-stream.ts). A
 * raw mic has a constant noise floor, so Deepgram's VAD never sees silence, so
 * `endpointing:500` never fires, so the utterance NEVER closes. Every final in a
 * bad session carries speech_final=false. With the segment open forever,
 * Deepgram re-decodes an ever-growing interim window and its processing falls
 * below real time -- asrLag climbed 0.7s -> 8.9s over 27s of continuous speech
 * while uplinkLag stayed flat at 0.6s. That is the "fine for a couple words,
 * then unbearable" lag.
 *
 * Deepgram's own remedy for exactly this is the Finalize message ("for
 * mid-stream finalization, like if you have your own client-side VAD"):
 * https://developers.deepgram.com/docs/finalize -- it flushes and closes the
 * open segment, resetting the decode window so cost drops back to real time.
 * We drive it on a wall-clock cap instead of waiting for VAD that will not come.
 *
 * This module is the pure decision. The socket send + timer live in
 * voice-stream.ts.
 */

/** How long a segment may stay open, actively receiving speech, before we force
 *  a close. Short enough to keep Deepgram's decode window near real time;
 *  long enough not to shred every sentence into fragments. */
export const FORCE_FINALIZE_MS = 2500

export interface EndpointerState {
  /** Wall-clock ms of the last segment close -- natural (speech_final) or forced. */
  lastCloseAt: number
  /** session.audioBytes as of the previous tick, to detect whether speech is flowing. */
  lastAudioBytes: number
}

export function createEndpointerState(now: number): EndpointerState {
  return { lastCloseAt: now, lastAudioBytes: 0 }
}

export interface EndpointerTick {
  now: number
  audioBytes: number
  /** dgWs is OPEN and the session is live (not stopping, has seen audio). */
  active: boolean
}

/**
 * Decide whether to send a Finalize this tick, and return the next state.
 *
 * Rules, in order:
 * - Not active (socket down / stopping / no audio yet): idle, hold the clock at
 *   `now` so a resume doesn't instantly trip the cap.
 * - No new audio since last tick (silence): the user isn't talking; hold the
 *   clock. Natural endpointing or KeepAlive owns silence, not us -- forcing a
 *   Finalize into a gap would just churn empty segments.
 * - Actively receiving speech and the segment has been open past the cap:
 *   finalize, and reset the clock so the next forced close is a full cap away.
 */
export function evaluateEndpointer(
  state: EndpointerState,
  tick: EndpointerTick,
): {
  finalize: boolean
  next: EndpointerState
} {
  if (!tick.active) {
    return { finalize: false, next: { lastCloseAt: tick.now, lastAudioBytes: tick.audioBytes } }
  }
  const talking = tick.audioBytes > state.lastAudioBytes
  if (!talking) {
    return { finalize: false, next: { lastCloseAt: tick.now, lastAudioBytes: tick.audioBytes } }
  }
  if (tick.now - state.lastCloseAt >= FORCE_FINALIZE_MS) {
    return { finalize: true, next: { lastCloseAt: tick.now, lastAudioBytes: tick.audioBytes } }
  }
  return { finalize: false, next: { ...state, lastAudioBytes: tick.audioBytes } }
}

/** Called when Deepgram closes a segment on its own (speech_final=true): the
 *  clock restarts from that natural close, so a well-behaved VAD session never
 *  triggers a forced Finalize at all. */
export function noteNaturalClose(state: EndpointerState, now: number): EndpointerState {
  return { ...state, lastCloseAt: now }
}
