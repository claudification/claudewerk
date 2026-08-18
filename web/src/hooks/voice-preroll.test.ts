/**
 * Regression tests for the pre-roll ring.
 *
 * THE BUG: push-to-talk lost the first word or two of every dictation. Four
 * costs sit between the key going down and the first sample being captured --
 * the 70ms chord grace window, a cold getUserMedia, building the AudioContext +
 * loading the worklet module (per press, until now), and the plain fact that a
 * person starts the first syllable as the key bottoms out. The uplink already
 * buffers everything from capture onwards (the 2026-07-23 fix), but buffering
 * cannot save audio that was never captured, and none of that window was.
 *
 * THE CONTRACT: while the mic is warm the graph keeps running and the last
 * `voicePrerollMs` of audio is held in a ring. Arming a recording hands that ring
 * over FIRST, in order, ahead of every live frame -- so the press chooses where
 * the recording began. The ring is dropped on stop and on release, because one
 * dictation's tail must never appear at the head of the next, and recorded speech
 * must not outlive the mic stream it came from.
 *
 * RED-first note: with `voicePrerollMs: 0` the ring is off and the module behaves
 * exactly as the code did before it existed -- which is the "ring off" test
 * below, and the failure mode every other test here would show without it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const prefs = { voicePrerollMs: 1500 }

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: { getState: () => ({ controlPanelPrefs: prefs }) },
}))

import type { CaptureEngine } from '@/hooks/voice-capture-contract'
import { PCM_SAMPLE_RATE, prewarmPcmContext } from '@/hooks/voice-capture-pcm'
import { startUplink } from '@/hooks/voice-deepgram-uplink'
import {
  FakeAudioContext,
  FakeAudioWorkletNode,
  FakeWebSocket,
  fakeStream,
  installVoiceFakes,
} from '@/hooks/voice-fakes'
import { armPreroll, disposePreroll, startPreroll } from '@/hooks/voice-preroll'

let restore: () => void

beforeEach(() => {
  restore = installVoiceFakes()
  prefs.voicePrerollMs = 1500
})

afterEach(() => {
  // Module-level state by design (the graph outlives every recording), so it has
  // to be torn down between tests or a ring leaks into the next one.
  disposePreroll()
  restore()
})

/** One PCM frame of `ms` milliseconds, tagged in sample 0 so order is assertable. */
function frame(marker: number, ms = 50): ArrayBuffer {
  const samples = new Int16Array(Math.round((ms / 1000) * PCM_SAMPLE_RATE))
  samples[0] = marker
  return samples.buffer
}

function markerOf(buf: ArrayBuffer): number {
  return new Int16Array(buf)[0] as number
}

/** Warm the graph the way acquireMicStream does, and hand back its worklet. */
async function warmMic(stream: MediaStream): Promise<FakeAudioWorkletNode> {
  startPreroll(stream)
  await vi.waitFor(() => expect(FakeAudioWorkletNode.instances.length).toBeGreaterThan(0))
  return FakeAudioWorkletNode.latest()
}

/** Everything the handler received, by marker, in order. */
function collector() {
  const got: number[] = []
  return { got, onChunk: (data: ArrayBuffer | Blob) => got.push(markerOf(data as ArrayBuffer)) }
}

describe('the ring', () => {
  test('hands over speech captured BEFORE the press, in order, ahead of live audio', async () => {
    const stream = fakeStream()
    const node = await warmMic(stream)

    // Spoken into the press: the grace window, the lead-in syllable.
    node.emit(frame(1))
    node.emit(frame(2))

    const { got, onChunk } = collector()
    const engine = armPreroll(stream, onChunk)
    expect(engine).not.toBeInstanceOf(Promise)

    // Spoken after the key was already down.
    node.emit(frame(3))

    expect(got).toEqual([1, 2, 3])
  })

  test('arming a warm graph is SYNCHRONOUS -- the press pays for no setup', async () => {
    const stream = fakeStream()
    await warmMic(stream)

    // The 50-300ms AudioContext + addModule cost used to land on every press.
    // A Promise here means it is back.
    expect(armPreroll(stream, () => {})).not.toBeInstanceOf(Promise)
  })

  test('keeps only the newest voicePrerollMs, evicting whole frames', async () => {
    prefs.voicePrerollMs = 100
    const stream = fakeStream()
    const node = await warmMic(stream)

    for (const marker of [1, 2, 3, 4, 5]) node.emit(frame(marker, 50))

    const { got, onChunk } = collector()
    armPreroll(stream, onChunk)

    expect(got).toEqual([4, 5])
  })

  test('voicePrerollMs 0 keeps nothing -- the off switch, and the old behaviour', async () => {
    prefs.voicePrerollMs = 0
    const stream = fakeStream()
    const node = await warmMic(stream)

    node.emit(frame(1))
    node.emit(frame(2))

    const { got, onChunk } = collector()
    armPreroll(stream, onChunk)
    node.emit(frame(3))

    // Only what was spoken after the press, which is exactly what was lost.
    expect(got).toEqual([3])
  })
})

describe('one dictation never leaks into the next', () => {
  test('a sent dictation is never pre-rolled into the next one', async () => {
    const stream = fakeStream()
    const node = await warmMic(stream)

    const first = collector()
    const engine = armPreroll(stream, first.onChunk) as CaptureEngine
    node.emit(frame(1))
    await engine.stop()

    const second = collector()
    armPreroll(stream, second.onChunk)
    node.emit(frame(3))

    // Frame 1 has already been transcribed once. Seeing it again at the head of
    // the next dictation would duplicate whole words.
    expect(first.got).toEqual([1])
    expect(second.got).toEqual([3])
  })

  test('the flush remainder goes to the dictation being released, and only there', async () => {
    const stream = fakeStream()
    const node = await warmMic(stream)

    const first = collector()
    const engine = armPreroll(stream, first.onChunk) as CaptureEngine
    // The worklet posts its sub-frame remainder BEFORE acking the flush -- the
    // last fraction of a word. It belongs to this utterance and no other.
    node.tailChunk = frame(9)
    await engine.stop()

    const second = collector()
    armPreroll(stream, second.onChunk)

    expect(first.got).toEqual([9])
    expect(second.got).toEqual([])
  })

  test('speech between a release and the next press is lead-in, not leakage', async () => {
    const stream = fakeStream()
    const node = await warmMic(stream)

    const engine = armPreroll(stream, () => {}) as CaptureEngine
    await engine.stop()

    // The graph never stopped capturing. This was said with no key down at all,
    // within the ring window of the next press -- so it is that press's lead-in,
    // which is the entire point of the feature.
    node.emit(frame(8))

    const next = collector()
    armPreroll(stream, next.onChunk)

    expect(next.got).toEqual([8])
  })
})

describe('the graph is warmed without the microphone', () => {
  test('prewarm builds the context and loads the worklet before any press', async () => {
    prewarmPcmContext()
    await vi.waitFor(() => expect(FakeAudioContext.modules).toHaveLength(1))

    // MEASURED at 316ms of a 1388ms cold-press loss, and none of it needs a
    // stream, a permission or the mic indicator. Paying it at the keypress was
    // the wrong moment, not an unavoidable cost.
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(FakeAudioContext.modules[0]).toMatch(/^\/pcm-worklet\.js\?v=/)
  })

  test('a cold press reuses the prewarmed context instead of building one', async () => {
    prewarmPcmContext()
    await vi.waitFor(() => expect(FakeAudioContext.modules).toHaveLength(1))

    await warmMic(fakeStream())

    // One context, one module load -- the press paid for a resume, not a build.
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(FakeAudioContext.modules).toHaveLength(1)
    expect(FakeAudioContext.latest().state).toBe('running')
  })

  test('releasing the mic suspends the context, it does not close it', async () => {
    const stream = fakeStream()
    await warmMic(stream)

    disposePreroll()

    // Closing is terminal, so the next cold press would have to rebuild -- which
    // is the whole 316ms this split exists to stop paying.
    const ctx = FakeAudioContext.latest()
    expect(ctx.closed).toBe(false)
    expect(ctx.state).toBe('suspended')

    // ...and the next press brings that same context back rather than making one.
    await armPreroll(stream, () => {})
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(FakeAudioContext.latest().state).toBe('running')
  })
})

describe('lifecycle', () => {
  test('a press during the warm-up joins the build instead of starting a SECOND graph', async () => {
    const stream = fakeStream()
    // The real cold press: acquireMicStream kicks the build off and beginDirect
    // arms it microseconds later, long before the worklet module has loaded.
    startPreroll(stream)
    const { got, onChunk } = collector()
    await armPreroll(stream, onChunk)

    // THE 2026-08-18 REGRESSION: the claim on the stream was recorded only after
    // the build resolved, so the press saw boundStream===null, read it as a
    // different mic, disposed the in-flight build and started its own. Two live
    // graphs both feed routeFrame, so every frame goes out TWICE -- and
    // interleaved duplicate linear16 is not audio flux can read. It answers with
    // no transcript and no error, which is indistinguishable from a dead mic.
    expect(FakeAudioContext.instances).toHaveLength(1)

    for (const node of FakeAudioWorkletNode.instances) node.emit(frame(1))
    expect(got).toEqual([1])
  })

  test('a suspended context is resumed, not replaced with a second one', async () => {
    const stream = fakeStream()
    await warmMic(stream)
    // Safari suspends a backgrounded context. Rebuilding on top of the live one
    // is the same two-graph duplication by another route.
    const ctx = FakeAudioContext.latest()
    ctx.state = 'suspended'

    await armPreroll(stream, () => {})

    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(ctx.state).toBe('running')
  })

  test('releasing the mic drops the ring -- recorded speech does not outlive the stream', async () => {
    const stream = fakeStream()
    const node = await warmMic(stream)
    node.emit(frame(1))

    disposePreroll()

    const { got, onChunk } = collector()
    const engine = armPreroll(stream, onChunk)
    expect(engine).toBeInstanceOf(Promise)
    await engine

    expect(got).toEqual([])
  })

  test('a different stream rebuilds the graph and starts from an empty ring', async () => {
    const first = fakeStream()
    const node = await warmMic(first)
    node.emit(frame(1))

    // Device switch: the ring belongs to a mic that is no longer the one in use.
    const second = fakeStream()
    const { got, onChunk } = collector()
    await armPreroll(second, onChunk)

    expect(got).toEqual([])
  })
})

describe('through the uplink', () => {
  test('pre-roll frames land at the HEAD of the pre-open buffer', async () => {
    const stream = fakeStream()
    const node = await warmMic(stream)
    node.emit(frame(1))
    node.emit(frame(2))

    const uplink = startUplink(stream, 'pcm16', { onOverflow: () => {}, onCaptureError: () => {} })
    node.emit(frame(3))

    const ws = new FakeWebSocket('wss://example')
    ws.readyState = FakeWebSocket.OPEN
    const stats = uplink.attach(ws as unknown as WebSocket)

    // Order is load-bearing even for raw PCM: it has no framing, so a hole is
    // silently mis-decoded rather than rejected.
    expect(ws.sent.map(s => markerOf(s as unknown as ArrayBuffer))).toEqual([1, 2, 3])
    expect(stats.chunks).toBe(3)
  })
})
