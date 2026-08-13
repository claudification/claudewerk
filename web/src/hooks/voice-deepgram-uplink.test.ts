/**
 * Regression tests for the pre-open audio buffer.
 *
 * THE BUG: the MediaRecorder used to be constructed inside `ws.onopen`, so every
 * word spoken between pressing the key and the Deepgram socket opening (token
 * mint + WS dial, easily 1-2s) was never captured at all. The mic light was on,
 * the UI said "recording", and the audio did not exist.
 *
 * THE CONTRACT: capture starts at construction; chunks buffer until a socket is
 * attached; the buffer is then flushed WHOLE and IN ORDER, because chunk 0 holds
 * the container header and Deepgram cannot decode a stream with a hole in it.
 *
 * The contract is now asserted against BOTH capture engines. The raw-PCM one
 * (which @cf/deepgram/flux requires -- it returns no transcript at all when fed a
 * container, silently) reaches the same guarantees by a completely different
 * route: an async worklet load instead of a synchronous constructor, and a port
 * ack instead of a `stop` event.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { startUplink } from '@/hooks/voice-deepgram-uplink'
import {
  FakeAudioContext,
  FakeAudioWorkletNode,
  FakeMediaRecorder,
  FakeWebSocket,
  fakeStream,
  installVoiceFakes,
} from '@/hooks/voice-fakes'

let restore: () => void

beforeEach(() => {
  restore = installVoiceFakes()
})

afterEach(() => {
  restore()
})

const noopCallbacks = { onOverflow: () => {}, onCaptureError: () => {} }

function blob(bytes: number, tag: string): Blob {
  return new Blob([tag.padEnd(bytes, '.')])
}

/** A PCM frame, distinguishable by its first sample so order is assertable. */
function pcm(marker: number): ArrayBuffer {
  return new Int16Array([marker, 0, 0, 0]).buffer
}

/** The worklet module load is async, so the engine does not exist until a
 *  microtask or two after startUplink returns. Every PCM test waits here. */
async function pcmNode(): Promise<FakeAudioWorkletNode> {
  await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(1))
  return FakeAudioWorkletNode.latest()
}

test('starts recording immediately, before any socket exists', () => {
  startUplink(fakeStream(), 'container', noopCallbacks)

  const rec = FakeMediaRecorder.latest()
  expect(rec.state).toBe('recording')
  expect(rec.timeslice).toBe(100)
})

test('buffers pre-open chunks and flushes them in order on attach', () => {
  const uplink = startUplink(fakeStream(), 'container', noopCallbacks)
  const rec = FakeMediaRecorder.latest()

  const first = blob(10, 'header')
  const second = blob(10, 'two')
  const third = blob(10, 'three')
  rec.emit(first)
  rec.emit(second)
  rec.emit(third)

  const ws = new FakeWebSocket('wss://example')
  ws.readyState = FakeWebSocket.OPEN
  const stats = uplink.attach(ws as unknown as WebSocket)

  expect(stats.chunks).toBe(3)
  expect(stats.bytes).toBe(first.size + second.size + third.size)
  // Order is load-bearing: the header chunk must arrive first.
  expect(ws.audio()).toEqual([first, second, third])
})

test('streams live once attached, with no re-send of the flushed buffer', () => {
  const uplink = startUplink(fakeStream(), 'container', noopCallbacks)
  const rec = FakeMediaRecorder.latest()

  const buffered = blob(10, 'buffered')
  rec.emit(buffered)

  const ws = new FakeWebSocket('wss://example')
  ws.readyState = FakeWebSocket.OPEN
  uplink.attach(ws as unknown as WebSocket)

  const live = blob(10, 'live')
  rec.emit(live)

  expect(ws.audio()).toEqual([buffered, live])
})

test('drops zero-size chunks rather than buffering them', () => {
  const uplink = startUplink(fakeStream(), 'container', noopCallbacks)
  FakeMediaRecorder.latest().emit(new Blob([]))

  const ws = new FakeWebSocket('wss://example')
  ws.readyState = FakeWebSocket.OPEN
  expect(uplink.attach(ws as unknown as WebSocket).chunks).toBe(0)
})

test('reports overflow instead of silently dropping chunks to make room', () => {
  const onOverflow = vi.fn()
  startUplink(fakeStream(), 'container', { onOverflow, onCaptureError: () => {} })
  const rec = FakeMediaRecorder.latest()

  // 4MB bound; 5 x 1MB crosses it.
  const big = new Blob([new Uint8Array(1_000_000)])
  for (let i = 0; i < 5; i++) rec.emit(big)

  expect(onOverflow).toHaveBeenCalledTimes(1)
  expect(onOverflow.mock.calls[0][0]).toBeGreaterThan(4_000_000)
})

test('stopRecorder resolves only AFTER the final chunk is delivered', async () => {
  const uplink = startUplink(fakeStream(), 'container', noopCallbacks)
  const rec = FakeMediaRecorder.latest()

  const ws = new FakeWebSocket('wss://example')
  ws.readyState = FakeWebSocket.OPEN
  uplink.attach(ws as unknown as WebSocket)

  // MediaRecorder emits its last chunk asynchronously after stop(); flushing
  // Deepgram before that lands is what truncated the tail of every utterance.
  const tail = blob(10, 'tail')
  rec.tailChunk = tail

  await uplink.stopRecorder()

  expect(ws.audio()).toEqual([tail])
})

test('stopRecorder resolves even if the stop event never fires', async () => {
  vi.useFakeTimers()
  try {
    const uplink = startUplink(fakeStream(), 'container', noopCallbacks)
    const rec = FakeMediaRecorder.latest()
    rec.stop = () => {
      rec.state = 'inactive'
    } // never fires onstop

    const settled = vi.fn()
    void uplink.stopRecorder().then(settled)

    await vi.advanceTimersByTimeAsync(500)
    expect(settled).toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

describe('pcm16 capture (what flux requires)', () => {
  test('buffers pre-open PCM frames and flushes them in order on attach', async () => {
    const uplink = startUplink(fakeStream(), 'pcm16', noopCallbacks)
    const node = await pcmNode()

    const first = pcm(1)
    const second = pcm(2)
    node.emit(first)
    node.emit(second)

    const ws = new FakeWebSocket('wss://example')
    ws.readyState = FakeWebSocket.OPEN
    const stats = uplink.attach(ws as unknown as WebSocket)

    // Raw PCM has no header to lose, but it has no framing either: a hole is
    // silently mis-decoded rather than rejected, so order still matters.
    expect(stats).toEqual({ chunks: 2, bytes: first.byteLength + second.byteLength })
    expect(ws.sent).toEqual([first, second])
  })

  test('loads the worklet from the served, cache-busted URL -- never a data: URI', async () => {
    startUplink(fakeStream(), 'pcm16', noopCallbacks)
    await pcmNode()

    // Safari is unreliable feeding data:/blob: URLs to addModule, and it is the
    // exact browser this path targets.
    expect(FakeAudioContext.modules[0]).toMatch(/^\/pcm-worklet\.js\?v=/)
    expect(FakeAudioWorkletNode.latest().processorName).toBe('pcm-capture')
  })

  test('stopRecorder resolves only AFTER the worklet flush ack -- no truncated tail', async () => {
    const uplink = startUplink(fakeStream(), 'pcm16', noopCallbacks)
    const node = await pcmNode()

    const ws = new FakeWebSocket('wss://example')
    ws.readyState = FakeWebSocket.OPEN
    uplink.attach(ws as unknown as WebSocket)

    // The worklet posts its sub-frame remainder BEFORE acking the flush; stopping
    // the session before that lands drops the last fraction of a word.
    const tail = pcm(9)
    node.tailChunk = tail

    await uplink.stopRecorder()

    expect(ws.sent).toEqual([tail])
  })

  test('drops audio produced after the flush ack -- the key release ends the utterance', async () => {
    const uplink = startUplink(fakeStream(), 'pcm16', noopCallbacks)
    const node = await pcmNode()

    const ws = new FakeWebSocket('wss://example')
    ws.readyState = FakeWebSocket.OPEN
    uplink.attach(ws as unknown as WebSocket)

    await uplink.stopRecorder()
    // Unlike MediaRecorder, nothing about a flush turns the audio graph off. Every
    // sample past this point is speech the user did not mean to send.
    node.emit(pcm(7))

    expect(ws.sent).toEqual([])
  })

  test('stopRecorder resolves even if the worklet never acks the flush', async () => {
    const uplink = startUplink(fakeStream(), 'pcm16', noopCallbacks)
    const node = await pcmNode()
    node.acksFlush = false

    // Real timers on purpose: the engine is built across awaits, so the 500ms
    // backstop is armed too late for a fake clock advanced from out here.
    const settled = vi.fn()
    void uplink.stopRecorder().then(settled)

    await vi.waitFor(() => expect(settled).toHaveBeenCalled(), { timeout: 2000 })
  })

  test('a released key before the worklet loaded still stops the engine', async () => {
    const uplink = startUplink(fakeStream(), 'pcm16', noopCallbacks)
    // No await: the engine does not exist yet. A quick tap must not leave a live
    // worklet streaming into a session nobody is listening to.
    await uplink.stopRecorder()

    const node = FakeAudioWorkletNode.latest()
    const ws = new FakeWebSocket('wss://example')
    ws.readyState = FakeWebSocket.OPEN
    uplink.attach(ws as unknown as WebSocket)
    node.emit(pcm(3))

    expect(ws.sent).toEqual([])
  })

  test('reports a worklet that fails to load instead of recording silence', async () => {
    FakeAudioContext.addModuleFails = true
    const onCaptureError = vi.fn()
    startUplink(fakeStream(), 'pcm16', { onOverflow: () => {}, onCaptureError })

    // No engine, no audio, and NO error would mean a mic that looks live and
    // transcribes nothing -- the exact silent failure this path is prone to.
    await vi.waitFor(() => expect(onCaptureError).toHaveBeenCalledTimes(1))
  })
})

test('dispose drops the buffer -- a cancelled recording sends nothing', () => {
  const uplink = startUplink(fakeStream(), 'container', noopCallbacks)
  const rec = FakeMediaRecorder.latest()
  rec.emit(blob(10, 'discarded'))

  uplink.dispose()

  const ws = new FakeWebSocket('wss://example')
  ws.readyState = FakeWebSocket.OPEN
  expect(uplink.attach(ws as unknown as WebSocket).chunks).toBe(0)
  expect(ws.audio()).toEqual([])
})
