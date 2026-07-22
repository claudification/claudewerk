import { expect, test } from 'bun:test'
import {
  createEndpointerState,
  type EndpointerState,
  evaluateEndpointer,
  type FinalizeReason,
  HARD_FINALIZE_MS,
  noteNaturalClose,
  PAUSE_MS,
  rmsFromLinear16,
  SOFT_FINALIZE_MS,
} from './voice-endpointer'

const CHUNK_MS = 50 // the client's AudioWorklet cadence
const AMBIENT_RMS = 0.0008 // ~-62 dBFS, a raw mic's noise floor

/**
 * Real speech is NOT a constant level -- at 50ms resolution it swings hard
 * between vowels and the near-ambient gaps of stops and word boundaries. Feeding
 * a constant RMS would model a fan, and a noise estimator is right to call that
 * noise. This pattern is loud with a one-chunk (50ms) dip every 200ms: well
 * inside PAUSE_MS, so it must never read as a pause.
 */
const SPEECH_PATTERN = [0.05, 0.07, 0.04, 0.0015]
const speech = (i: number) => SPEECH_PATTERN[i % SPEECH_PATTERN.length]
const ambient = () => AMBIENT_RMS

/** Feed `ms` of audio, collecting every Finalize that fired. */
function feed(
  state: EndpointerState,
  from: number,
  ms: number,
  level: (i: number) => number,
  opts: { pcm?: boolean; active?: boolean } = {},
): { state: EndpointerState; fired: Array<{ at: number; reason: FinalizeReason }>; end: number } {
  const fired: Array<{ at: number; reason: FinalizeReason }> = []
  let s = state
  let now = from
  let i = 0
  const until = from + ms
  while (now < until) {
    now += CHUNK_MS
    const d = evaluateEndpointer(s, { now, rms: level(i++), pcm: opts.pcm ?? true, active: opts.active ?? true })
    if (d.finalize) fired.push({ at: now, reason: d.finalize })
    s = d.next
  }
  return { state: s, fired, end: now }
}

test('REGRESSION: continuous PCM silence never forces a Finalize', () => {
  // The old gate was `audioBytes > lastAudioBytes`, and the client streams PCM
  // unconditionally -- so silence fired a Finalize every 2.5s forever.
  const { fired } = feed(createEndpointerState(0), 0, 20_000, ambient)
  expect(fired).toEqual([])
})

test('unbroken speech is cut by the hard cap only, not the soft cap', () => {
  const { fired } = feed(createEndpointerState(0), 0, 9_000, speech)
  // Nothing at the soft cap (no pause to cut at); one cut at the hard ceiling.
  expect(fired).toEqual([{ at: HARD_FINALIZE_MS, reason: 'hard-cap' }])
})

test('past the soft cap, the segment closes at the first real pause', () => {
  const talk = feed(createEndpointerState(0), 0, 3_000, speech)
  expect(talk.fired).toEqual([])
  const quiet = feed(talk.state, talk.end, 1_000, ambient)
  expect(quiet.fired).toHaveLength(1)
  expect(quiet.fired[0].reason).toBe('pause')
  // Cut once the pause has actually lasted PAUSE_MS, measured from the last
  // chunk that carried speech (the run can end on one of its own 50ms dips).
  const silentFor = quiet.fired[0].at - talk.state.lastSpeechAt
  expect(silentFor).toBeGreaterThanOrEqual(PAUSE_MS)
  expect(silentFor).toBeLessThan(PAUSE_MS + 2 * CHUNK_MS)
})

test('a pause before the soft cap defers the cut to the soft cap', () => {
  const talk = feed(createEndpointerState(0), 0, 1_000, speech)
  const quiet = feed(talk.state, talk.end, 4_000, ambient)
  // One cut, and not before the segment has earned it.
  expect(quiet.fired).toHaveLength(1)
  expect(quiet.fired[0].at).toBeGreaterThanOrEqual(SOFT_FINALIZE_MS)
  expect(quiet.fired[0].reason).toBe('pause')
})

test('a closed segment with no new speech never churns another Finalize', () => {
  // The chars=0 finals in the logs: Finalize fired into a gap, again and again.
  const talk = feed(createEndpointerState(0), 0, 3_000, speech)
  const quiet = feed(talk.state, talk.end, 30_000, ambient)
  expect(quiet.fired).toHaveLength(1)
})

test('a natural VAD close restarts the clock', () => {
  const talk = feed(createEndpointerState(0), 0, 2_000, speech)
  const s = noteNaturalClose(talk.state, talk.end)
  // Deepgram closed it for us at 2000; the next cut is a full window away.
  const more = feed(s, talk.end, 2_000, speech)
  expect(more.fired).toEqual([])
})

test('an inactive socket holds the clock so a resume gets a full window', () => {
  const down = feed(createEndpointerState(0), 0, 5_000, ambient, { active: false })
  const up = feed(down.state, down.end, 2_000, speech)
  expect(up.fired).toEqual([])
})

test('non-PCM audio (container) falls back to the hard cap alone', () => {
  // We cannot measure RMS of webm/opus, so every chunk counts as speech.
  const { fired } = feed(createEndpointerState(0), 0, 9_000, ambient, { pcm: false })
  expect(fired).toEqual([{ at: HARD_FINALIZE_MS, reason: 'hard-cap' }])
})

test('speech is detected relative to a raised noise floor, not an absolute', () => {
  // A loud room: ambient sits well above SPEECH_FLOOR_MIN. After the floor
  // tracks up, that same ambient must NOT read as speech.
  const loudAmbient = 0.01
  const { fired, state } = feed(createEndpointerState(0), 0, 60_000, () => loudAmbient)
  expect(state.noiseFloor).toBeGreaterThan(0.005)
  // It fires at most once (the initial burst before the floor caught up), never
  // on a metronome.
  expect(fired.length).toBeLessThanOrEqual(1)
})

test('rmsFromLinear16 reads signed little-endian samples', () => {
  expect(rmsFromLinear16(new Uint8Array([]))).toBe(0)
  expect(rmsFromLinear16(new Uint8Array([0, 0, 0, 0]))).toBe(0)
  // Odd trailing byte is ignored, not misread as half a sample.
  expect(rmsFromLinear16(new Uint8Array([0, 0, 0, 0, 7]))).toBe(0)

  // Full-scale square wave: +32767 / -32768 alternating -> RMS ~= 1.0
  const full = new Uint8Array([0xff, 0x7f, 0x00, 0x80])
  expect(rmsFromLinear16(full)).toBeCloseTo(1, 3)

  // -1 (0xffff) must read as -1, not 65535.
  const minusOne = new Uint8Array([0xff, 0xff, 0xff, 0xff])
  expect(rmsFromLinear16(minusOne)).toBeCloseTo(1 / 32768, 6)
})
