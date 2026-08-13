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
 *  2. TRUNCATED TAIL AT THE END -- stop() told the server the audio was over
 *     immediately after recorder.stop(), but MediaRecorder delivers its final
 *     chunk on a LATER task. That chunk reached the socket after the stream had
 *     been closed (Safari: up to a full second of speech).
 *
 * The transport moved from api.deepgram.com to our own Cloudflare Worker
 * (2026-08-13, because Deepgram-direct ran 8.5-11.8s behind real time from
 * Thailand), so the wire is now: audio up as binary, ONE `{type:'stop'}` control
 * message, and normalised `transcript` / `done` frames down. Both bugs above are
 * transport-independent and still pinned.
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { startDeepgramDirect } from '@/hooks/voice-deepgram-direct'
import {
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

test('dials the Worker with the token in the QUERY STRING, not a subprotocol', async () => {
  begin('tok-123')
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

  const ws = FakeWebSocket.latest()
  // A browser cannot set a header on a WebSocket, and Cloudflare -- unlike
  // Deepgram -- does not accept a token as a subprotocol. Query string or nothing.
  expect(ws.url).toContain('t=tok-123')
  expect(ws.url).toContain('model=nova-3')
  expect(ws.url).toContain('/listen?')
})

test('flux captures raw PCM and DECLARES it -- the silent-no-op guard', async () => {
  const session = startDeepgramDirect({ stream: fakeStream(), token: 'tok', model: 'flux', callbacks: callbacks() })
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

  // Fed a container, flux accepts every byte, errors on nothing, and returns NO
  // transcript. There is no failure to catch, so the pairing is asserted here.
  expect(FakeAudioWorkletNode.instances).toHaveLength(1)
  expect(FakeMediaRecorder.instances).toHaveLength(0)

  // And raw PCM has no container to sniff: undeclared, it decodes to nothing.
  const url = new URL(FakeWebSocket.latest().url.replace('wss://', 'https://'))
  expect(url.searchParams.get('model')).toBe('flux')
  expect(url.searchParams.get('encoding')).toBe('linear16')
  expect(url.searchParams.get('sample_rate')).toBe('16000')

  session.abort()
})

test('nova-3 captures a container and declares no encoding, so it auto-detects', async () => {
  const { session } = begin('tok')
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

  expect(FakeMediaRecorder.instances).toHaveLength(1)
  expect(FakeAudioWorkletNode.instances).toHaveLength(0)
  expect(FakeWebSocket.latest().url).not.toContain('encoding=')

  session.abort()
})

test('forwards only the end-of-turn tuning it was given', async () => {
  const session = startDeepgramDirect({
    stream: fakeStream(),
    token: 'tok',
    model: 'flux',
    tuning: { eot_threshold: '0.7', eot_timeout_ms: '' },
    callbacks: callbacks(),
  })
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

  const url = FakeWebSocket.latest().url
  expect(url).toContain('eot_threshold=0.7')
  // An empty setting must not become a real one: eot_timeout_ms=0 would end
  // every turn instantly, shredding a long dictation into one-word paragraphs.
  expect(url).not.toContain('eot_timeout_ms')

  session.abort()
})

test('repeats keyterm per term -- a set() would keep only the last', async () => {
  const session = startDeepgramDirect({
    stream: fakeStream(),
    token: 'tok',
    model: 'flux',
    keyterms: ['Cloudflare', '  ', 'agent host', 'claudewerk'],
    callbacks: callbacks(),
  })
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

  const url = new URL(FakeWebSocket.latest().url.replace('wss://', 'https://'))
  // Measured, not assumed: this is what turned "CloudFlo" into "Cloudflare".
  expect(url.searchParams.getAll('keyterm')).toEqual(['Cloudflare', 'agent host', 'claudewerk'])

  session.abort()
})

test('caps the keyterm list, because a long one measurably stops working', async () => {
  const many = Array.from({ length: 80 }, (_, i) => `term-${i}`)
  const session = startDeepgramDirect({
    stream: fakeStream(),
    token: 'tok',
    model: 'flux',
    keyterms: many,
    callbacks: callbacks(),
  })
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

  // 4 and 6 terms fixed "CloudFlo" on the probe fixture; 10 and 25 undid the
  // fix. The cap is that measurement, not URL hygiene.
  const sent = new URL(FakeWebSocket.latest().url.replace('wss://', 'https://')).searchParams.getAll('keyterm')
  expect(sent).toHaveLength(8)
  expect(sent[0]).toBe('term-0')

  session.abort()
})

test('sends stop only AFTER the recorder final chunk -- no truncated tail', async () => {
  const { session } = begin('tok')
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  const ws = FakeWebSocket.latest()
  ws.open()

  const rec = FakeMediaRecorder.latest()
  const tail = new Blob(['the-last-words'])
  rec.tailChunk = tail

  void session.stop()
  await vi.waitFor(() => expect(ws.controlTypes()).toContain('stop'))

  // The tail audio must be on the wire BEFORE the server is told it ended.
  const tailIndex = ws.sent.indexOf(tail)
  const stopIndex = ws.sent.findIndex(s => typeof s === 'string' && s.includes('stop'))
  expect(tailIndex).toBeGreaterThanOrEqual(0)
  expect(tailIndex).toBeLessThan(stopIndex)
  expect(ws.controlTypes()).toEqual(['stop'])
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
  expect(ws.controlTypes()).toEqual(['stop'])

  ws.serverSend({ type: 'done', text: 'quick tap', reason: 'upstream-done' })
  await expect(stopped).resolves.toBe('quick tap')
})

test('accumulates finals and resolves stop() with the full transcript', async () => {
  const { session, cbs } = begin('tok')
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  const ws = FakeWebSocket.latest()
  ws.open()

  // `text` is the segment in flight, `committed` is what is already finished --
  // the client renders committed+text and NEVER appends, which is what lets a
  // cumulative model (flux) and a delta model (nova-3) share this code.
  ws.serverSend({ type: 'transcript', text: 'hello', committed: '', final: false })
  ws.serverSend({ type: 'transcript', text: 'hello there', committed: '', final: true })
  ws.serverSend({ type: 'transcript', text: 'friend', committed: 'hello there ', final: true })

  expect(cbs.onTranscript).toHaveBeenCalledTimes(3)
  expect(cbs.onTranscript.mock.calls[2][0]).toMatchObject({ transcript: 'friend', accumulated: 'hello there ' })

  const stopped = session.stop()
  await vi.waitFor(() => expect(ws.controlTypes()).toContain('stop'))
  // The Worker's `done` carries the WHOLE dictation and wins over anything
  // accumulated frame by frame.
  ws.serverSend({ type: 'done', text: 'hello there friend', reason: 'upstream-done' })

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
