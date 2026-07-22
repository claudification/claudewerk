/**
 * Regression tests for the direct-to-Deepgram session.
 *
 * Two bugs are pinned here, both about ORDERING against a socket that is not up
 * yet or a recorder that has not finished:
 *
 *  1. DEAD WINDOW AT THE START -- the recorder was constructed inside ws.onopen,
 *     which itself only ran after `await fetchDeepgramToken()`. Everything said
 *     during the mint + dial was never captured. Capture must begin at the call,
 *     with the token still an unresolved promise.
 *
 *  2. TRUNCATED TAIL AT THE END -- stop() sent Finalize/CloseStream immediately
 *     after recorder.stop(), but MediaRecorder delivers its final chunk on a
 *     LATER task. That chunk reached the socket after Deepgram had been told the
 *     stream was over (Safari: up to a full second of speech).
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { startDeepgramDirect } from '@/hooks/voice-deepgram-direct'
import { FakeMediaRecorder, FakeWebSocket, fakeStream, installVoiceFakes } from '@/hooks/voice-fakes'

let restore: () => void

beforeEach(() => {
  restore = installVoiceFakes()
})

afterEach(() => {
  restore()
})

function callbacks() {
  return { onTranscript: vi.fn(), onOpen: vi.fn(), onError: vi.fn() }
}

function begin(token: string | Promise<string>, cbs = callbacks()) {
  const session = startDeepgramDirect({ stream: fakeStream(), token, model: 'nova-3', callbacks: cbs })
  return { session, cbs }
}

test('records BEFORE the token resolves -- no dead window during the mint', () => {
  let release!: (t: string) => void
  begin(new Promise<string>(res => (release = res)))

  // Nothing dialled yet -- but the mic is already being captured.
  expect(FakeWebSocket.instances).toHaveLength(0)
  expect(FakeMediaRecorder.latest().state).toBe('recording')

  release('tok')
})

test('flushes everything spoken during mint + dial once the socket opens', async () => {
  let release!: (t: string) => void
  const { cbs } = begin(new Promise<string>(res => (release = res)))
  const rec = FakeMediaRecorder.latest()

  const duringMint = new Blob(['spoken-during-mint'])
  rec.emit(duringMint)

  release('tok')
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

  const duringDial = new Blob(['spoken-during-dial'])
  rec.emit(duringDial)

  const ws = FakeWebSocket.latest()
  expect(ws.audio()).toEqual([]) // still CONNECTING -- held, not dropped
  ws.open()

  expect(ws.audio()).toEqual([duringMint, duringDial])
  expect(cbs.onOpen).toHaveBeenCalledWith({ chunks: 2, bytes: duringMint.size + duringDial.size })
})

test('opens with the bearer subprotocol and the configured model', async () => {
  begin('tok-123')
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

  const ws = FakeWebSocket.latest()
  expect(ws.protocols).toEqual(['bearer', 'tok-123'])
  expect(ws.url).toContain('model=nova-3')
})

test('sends Finalize only AFTER the recorder final chunk -- no truncated tail', async () => {
  const { session } = begin('tok')
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  const ws = FakeWebSocket.latest()
  ws.open()

  const rec = FakeMediaRecorder.latest()
  const tail = new Blob(['the-last-words'])
  rec.tailChunk = tail

  void session.stop()
  await vi.waitFor(() => expect(ws.controlTypes()).toContain('Finalize'))

  // The tail audio must be on the wire BEFORE Deepgram is told the stream ended.
  const tailIndex = ws.sent.indexOf(tail)
  const finalizeIndex = ws.sent.findIndex(s => typeof s === 'string' && s.includes('Finalize'))
  expect(tailIndex).toBeGreaterThanOrEqual(0)
  expect(tailIndex).toBeLessThan(finalizeIndex)
  expect(ws.controlTypes()).toEqual(['Finalize', 'CloseStream'])
})

test('a release during the dial still flushes and finalizes once open', async () => {
  let release!: (t: string) => void
  const { session } = begin(new Promise<string>(res => (release = res)))
  const rec = FakeMediaRecorder.latest()
  const utterance = new Blob(['quick-tap'])
  rec.emit(utterance)

  const stopped = session.stop()
  release('tok')
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

  const ws = FakeWebSocket.latest()
  ws.open()

  // Audio first, then the handshake -- the whole utterance survives a release
  // that happened before the socket ever came up.
  expect(ws.audio()).toEqual([utterance])
  expect(ws.controlTypes()).toEqual(['Finalize', 'CloseStream'])

  ws.serverSend({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'quick tap' }] } })
  ws.serverSend({ type: 'Metadata' })
  await expect(stopped).resolves.toBe('quick tap')
})

test('accumulates finals and resolves stop() with the full transcript', async () => {
  const { session, cbs } = begin('tok')
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  const ws = FakeWebSocket.latest()
  ws.open()

  ws.serverSend({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'hello' }] } })
  ws.serverSend({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'hello there' }] } })
  ws.serverSend({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'friend' }] } })

  expect(cbs.onTranscript).toHaveBeenCalledTimes(3)

  const stopped = session.stop()
  await vi.waitFor(() => expect(ws.controlTypes()).toContain('CloseStream'))
  ws.serverSend({ type: 'Metadata' })

  await expect(stopped).resolves.toBe('hello there friend')
})

test('reports a token mint failure as a token failure, and never dials', async () => {
  const { cbs } = begin(Promise.reject(new Error('broker 503')))

  await vi.waitFor(() => expect(cbs.onError).toHaveBeenCalled())
  expect(cbs.onError.mock.calls[0][1]).toBe('token')
  expect(cbs.onError.mock.calls[0][0]).toContain('broker 503')
  expect(FakeWebSocket.instances).toHaveLength(0)
})

test('abort after a mint failure does not dial a socket', async () => {
  let release!: (t: string) => void
  const { session } = begin(new Promise<string>(res => (release = res)))

  session.abort()
  release('tok')
  await Promise.resolve()
  await Promise.resolve()

  expect(FakeWebSocket.instances).toHaveLength(0)
})
