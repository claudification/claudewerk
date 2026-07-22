import { expect, test } from 'bun:test'
import {
  createEndpointerState,
  type EndpointerState,
  evaluateEndpointer,
  FORCE_FINALIZE_MS,
  noteNaturalClose,
} from './voice-endpointer'

/** Drive a sequence of ticks and collect the ticks that fired a Finalize. */
function run(
  state: EndpointerState,
  ticks: Array<{ now: number; audioBytes: number; active: boolean }>,
): { firedAt: number[]; state: EndpointerState } {
  const firedAt: number[] = []
  let s = state
  for (const t of ticks) {
    const { finalize, next } = evaluateEndpointer(s, t)
    if (finalize) firedAt.push(t.now)
    s = next
  }
  return { firedAt, state: s }
}

test('continuous speech past the cap forces exactly one Finalize per cap window', () => {
  const start = createEndpointerState(0)
  // Audio flows every second (bytes always increasing). Cap is 2500ms.
  const ticks = Array.from({ length: 6 }, (_, i) => ({
    now: (i + 1) * 1000,
    audioBytes: (i + 1) * 32000,
    active: true,
  }))
  const { firedAt } = run(start, ticks)
  // First fire at the first tick >= 2500ms (t=3000), then 2500ms later (t=6000... but
  // only ticks at 5000/6000 exist -> next fire once >= lastClose+cap).
  expect(firedAt).toEqual([3000, 6000])
})

test('silence never triggers a forced Finalize -- endpointing/KeepAlive owns gaps', () => {
  const start = createEndpointerState(0)
  // Active socket but audioBytes never grows: the user is not talking.
  const ticks = Array.from({ length: 6 }, (_, i) => ({ now: (i + 1) * 1000, audioBytes: 5000, active: true }))
  const { firedAt } = run(start, ticks)
  expect(firedAt).toEqual([])
})

test('a natural VAD close resets the clock so no forced Finalize fires', () => {
  let s = createEndpointerState(0)
  // Talk for 2s...
  ;[1000, 2000].forEach((now, i) => {
    s = evaluateEndpointer(s, { now, audioBytes: (i + 1) * 32000, active: true }).next
  })
  // Deepgram closes the segment naturally at 2000ms.
  s = noteNaturalClose(s, 2000)
  // ...keep talking; the cap is measured from the natural close, not the start.
  const { firedAt } = run(s, [
    { now: 3000, audioBytes: 96000, active: true },
    { now: 4000, audioBytes: 128000, active: true }, // 4000 - 2000 < 2500 -> no fire yet
  ])
  expect(firedAt).toEqual([])
})

test('an inactive socket holds the clock so a resume gets a full window', () => {
  let s = createEndpointerState(0)
  // Socket down for a while (e.g. still dialing Deepgram).
  s = evaluateEndpointer(s, { now: 5000, audioBytes: 0, active: false }).next
  // Comes active and audio starts flowing at 6000; must NOT immediately fire
  // just because wall clock is already > cap past state creation.
  const { firedAt } = run(s, [
    { now: 6000, audioBytes: 32000, active: true },
    { now: 7000, audioBytes: 64000, active: true }, // 7000 - 5000 < 2500 -> no
  ])
  expect(firedAt).toEqual([])
})

test('the cap constant is short enough to keep the decode window near real time', () => {
  // Guard: the measured failure had a ~15s+ open window. The cap must stay well
  // under that or it does not bound asrLag.
  expect(FORCE_FINALIZE_MS).toBeLessThanOrEqual(3000)
})
