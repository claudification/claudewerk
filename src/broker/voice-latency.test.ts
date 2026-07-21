import { expect, test } from 'bun:test'
import { bytesPerSecondFor, computeLegs, createLatencyTracker, formatLegs } from './voice-latency'

test('bytesPerSecondFor: linear16 is 2 bytes per mono sample', () => {
  expect(bytesPerSecondFor('linear16', 16000)).toBe(32000)
  expect(bytesPerSecondFor('linear16', 48000)).toBe(96000)
  expect(bytesPerSecondFor('linear16', undefined)).toBe(32000) // defaults to 16k
})

test('bytesPerSecondFor: container auto-detect is unmeasurable, not guessed', () => {
  expect(bytesPerSecondFor(undefined, 16000)).toBe(0)
  expect(bytesPerSecondFor('opus', 16000)).toBe(0)
})

test('computeLegs: a healthy session has both legs near zero', () => {
  // 10s of wall clock, 10s of audio submitted, Deepgram processed 9.8s of it.
  const legs = computeLegs({
    elapsedMs: 10_000,
    audioBytes: 32000 * 10,
    bytesPerSecond: 32000,
    start: 9.5,
    duration: 0.3,
  })
  expect(legs.submittedSec).toBe(10)
  expect(legs.processedSec).toBeCloseTo(9.8, 5)
  expect(legs.uplinkLagSec).toBe(0)
  expect(legs.asrLagSec).toBeCloseTo(0.2, 5)
})

test('computeLegs: Deepgram falling behind shows up as asrLag, uplink stays clean', () => {
  // The reported bug: audio arrives in real time but transcripts are 30s behind.
  const legs = computeLegs({
    elapsedMs: 110_000,
    audioBytes: 32000 * 110,
    bytesPerSecond: 32000,
    start: 79,
    duration: 1,
  })
  expect(legs.uplinkLagSec).toBe(0)
  expect(legs.asrLagSec).toBe(30)
})

test('computeLegs: a delivery stall shows up as uplinkLag instead', () => {
  // 110s of wall clock but only 80s of audio ever reached us.
  const legs = computeLegs({
    elapsedMs: 110_000,
    audioBytes: 32000 * 80,
    bytesPerSecond: 32000,
    start: 79,
    duration: 1,
  })
  expect(legs.uplinkLagSec).toBe(30)
  expect(legs.asrLagSec).toBe(0)
})

test('computeLegs: unknown encoding yields zero submitted rather than a fabricated number', () => {
  const legs = computeLegs({ elapsedMs: 1000, audioBytes: 99999, bytesPerSecond: 0, start: 0, duration: 0 })
  expect(legs.submittedSec).toBe(0)
})

test('formatLegs: stable field order', () => {
  const line = formatLegs({ wallSec: 1, submittedSec: 1, processedSec: 1, uplinkLagSec: 0, asrLagSec: 0 }, 'interim#1')
  expect(line).toBe('[voice-lat] interim#1 wall=1.00s submitted=1.00s processed=1.00s uplinkLag=0.00s asrLag=0.00s')
})

test('tracker: finals are excluded from the measurement (they conflate EOT latency)', () => {
  const tracker = createLatencyTracker(32000, () => Date.now() - 10_000)
  expect(tracker.onResult({ isFinal: true, start: 0, duration: 1, audioBytes: 32000 })).toBeNull()
  expect(tracker.summary()).toContain('no interim samples')
  expect(tracker.summary()).toContain('finals=1')
})

test('tracker: first interim always samples, then throttles', () => {
  const tracker = createLatencyTracker(32000, () => Date.now() - 10_000)
  const first = tracker.onResult({ isFinal: false, start: 9, duration: 0.5, audioBytes: 32000 * 10 })
  expect(first).toContain('[voice-lat] interim#1')
  // Immediately after, the throttle suppresses the line.
  expect(tracker.onResult({ isFinal: false, start: 9, duration: 0.6, audioBytes: 32000 * 10 })).toBeNull()
})

test('tracker: summary calls out GROWING lag, which is the whole point', () => {
  const tracker = createLatencyTracker(32000, () => Date.now() - 110_000)
  // First interim: nearly caught up.
  tracker.onResult({ isFinal: false, start: 9.5, duration: 0.3, audioBytes: 32000 * 10 })
  // Much later: Deepgram is 30s behind.
  tracker.onResult({ isFinal: false, start: 79, duration: 1, audioBytes: 32000 * 110 })
  const summary = tracker.summary()
  expect(summary).toContain('GROWING')
  expect(summary).toContain('peak=30.00s')
})

test('tracker: a stable session is not reported as growing', () => {
  const tracker = createLatencyTracker(32000, () => Date.now() - 10_000)
  tracker.onResult({ isFinal: false, start: 9.5, duration: 0.3, audioBytes: 32000 * 10 })
  tracker.onResult({ isFinal: false, start: 9.7, duration: 0.3, audioBytes: 32000 * 10 })
  expect(tracker.summary()).toContain('stable')
})

test('tracker: no audio yet means no sample rather than a bogus zero', () => {
  const tracker = createLatencyTracker(32000, () => 0)
  expect(tracker.onResult({ isFinal: false, start: 0, duration: 0, audioBytes: 0 })).toBeNull()
})
