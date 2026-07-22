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
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { startUplink } from '@/hooks/voice-deepgram-uplink'
import { FakeMediaRecorder, FakeWebSocket, fakeStream, installVoiceFakes } from '@/hooks/voice-fakes'

let restore: () => void

beforeEach(() => {
  restore = installVoiceFakes()
})

afterEach(() => {
  restore()
})

const noopCallbacks = { onOverflow: () => {} }

function blob(bytes: number, tag: string): Blob {
  return new Blob([tag.padEnd(bytes, '.')])
}

test('starts recording immediately, before any socket exists', () => {
  startUplink(fakeStream(), noopCallbacks)

  const rec = FakeMediaRecorder.latest()
  expect(rec.state).toBe('recording')
  expect(rec.timeslice).toBe(100)
})

test('buffers pre-open chunks and flushes them in order on attach', () => {
  const uplink = startUplink(fakeStream(), noopCallbacks)
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
  const uplink = startUplink(fakeStream(), noopCallbacks)
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
  const uplink = startUplink(fakeStream(), noopCallbacks)
  FakeMediaRecorder.latest().emit(new Blob([]))

  const ws = new FakeWebSocket('wss://example')
  ws.readyState = FakeWebSocket.OPEN
  expect(uplink.attach(ws as unknown as WebSocket).chunks).toBe(0)
})

test('reports overflow instead of silently dropping chunks to make room', () => {
  const onOverflow = vi.fn()
  startUplink(fakeStream(), { onOverflow })
  const rec = FakeMediaRecorder.latest()

  // 4MB bound; 5 x 1MB crosses it.
  const big = new Blob([new Uint8Array(1_000_000)])
  for (let i = 0; i < 5; i++) rec.emit(big)

  expect(onOverflow).toHaveBeenCalledTimes(1)
  expect(onOverflow.mock.calls[0][0]).toBeGreaterThan(4_000_000)
})

test('stopRecorder resolves only AFTER the final chunk is delivered', async () => {
  const uplink = startUplink(fakeStream(), noopCallbacks)
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
    const uplink = startUplink(fakeStream(), noopCallbacks)
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

test('dispose drops the buffer -- a cancelled recording sends nothing', () => {
  const uplink = startUplink(fakeStream(), noopCallbacks)
  const rec = FakeMediaRecorder.latest()
  rec.emit(blob(10, 'discarded'))

  uplink.dispose()

  const ws = new FakeWebSocket('wss://example')
  ws.readyState = FakeWebSocket.OPEN
  expect(uplink.attach(ws as unknown as WebSocket).chunks).toBe(0)
  expect(ws.audio()).toEqual([])
})
