/**
 * Regression tests for the release-truncation bug.
 *
 * doStop() used to decide "is more text coming?" by checking whether a yellow
 * interim was on screen. Interims trail speech by 100-300ms, so releasing the
 * key right after the last word leaves audio that has produced NO interim --
 * the check said "nothing in flight", submitted, flipped to 'submitting', and
 * applyTranscript then early-returned on every transcript that followed,
 * including Deepgram's flush carrying exactly those missing words.
 *
 * The contract now: release NEVER submits. Only voice_final does.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const sendWsMessage = vi.fn()
const historyEntries: Array<{ raw: string; refined: string }> = []

/** Listeners registered by the hook on the broker socket. */
let listeners: Array<(e: MessageEvent) => void> = []

const fakeWs = {
  readyState: 1, // WebSocket.OPEN
  addEventListener: (_type: string, fn: (e: MessageEvent) => void) => listeners.push(fn),
  removeEventListener: (_type: string, fn: (e: MessageEvent) => void) => {
    listeners = listeners.filter(l => l !== fn)
  },
}

/** Push a broker->browser message through every registered listener. */
function emit(msg: Record<string, unknown>) {
  const event = { data: JSON.stringify(msg) } as MessageEvent
  for (const fn of [...listeners]) fn(event)
}

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: {
    getState: () => ({
      ws: fakeWs,
      sendWsMessage,
      selectedConversationId: 'conv_test',
      controlPanelPrefs: { voiceLingerMs: 0 },
    }),
  },
}))

vi.mock('@/hooks/voice-mic-stream', () => ({
  acquireMicStream: async () => ({ getAudioTracks: () => [{ onended: null }] }),
  isStreamLive: () => true,
  releaseWarmStream: vi.fn(),
  scheduleStreamRelease: vi.fn(),
  setMicExpired: vi.fn(),
  dismissMicExpired: vi.fn(),
  getMicExpired: () => false,
  invalidateWarmStream: vi.fn(),
  prewarmMicStream: vi.fn(),
  subscribeMicExpired: () => () => {},
}))

vi.mock('@/hooks/voice-pcm-capture', () => ({
  PCM_ENCODING: 'linear16',
  PCM_SAMPLE_RATE: 16000,
  startPcmCapture: async () => ({ flush: async () => {}, stop: vi.fn() }),
}))

vi.mock('@/lib/voice-history', () => ({
  addVoiceHistoryEntry: (e: { raw: string; refined: string }) => historyEntries.push(e),
}))

const { useVoiceRecording } = await import('@/hooks/use-voice-recording')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  listeners = []
  historyEntries.length = 0
  sendWsMessage.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Start a recording and get it into the 'recording' state with Deepgram ready. */
async function startRecording() {
  const hook = renderHook(() => useVoiceRecording())
  await act(async () => {
    await hook.result.current.start()
  })
  act(() => emit({ type: 'voice_ready', flushedChunks: 0, flushedBytes: 0 }))
  await waitFor(() => expect(hook.result.current.state).toBe('recording'))
  return hook
}

test('release does not submit while Deepgram may still have words -- even with no interim showing', async () => {
  const hook = await startRecording()

  // One finalized segment, and NO interim pending: this is exactly the state
  // that the old code read as "nothing in flight" and submitted on.
  act(() =>
    emit({
      type: 'voice_transcript',
      isFinal: true,
      accumulated: 'the quick brown fox',
      transcript: 'the quick brown fox',
    }),
  )
  expect(hook.result.current.interimText).toBe('')

  act(() => hook.result.current.stop())

  // Must NOT have submitted -- the tail is still outstanding.
  expect(hook.result.current.state).toBe('refining')
  expect(hook.result.current.refinedText).toBe('')
})

test('voice_final submits the COMPLETE transcript including the post-release tail', async () => {
  const hook = await startRecording()
  act(() =>
    emit({
      type: 'voice_transcript',
      isFinal: true,
      accumulated: 'the quick brown fox',
      transcript: 'the quick brown fox',
    }),
  )
  act(() => hook.result.current.stop())

  // Deepgram's flush lands the words the user spoke just before release.
  act(() =>
    emit({ type: 'voice_final', accumulated: 'the quick brown fox jumps over the lazy dog', reason: 'from_finalize' }),
  )

  await waitFor(() => expect(hook.result.current.state).toBe('submitting'))
  expect(hook.result.current.refinedText).toBe('the quick brown fox jumps over the lazy dog')
})

test('a late isFinal no longer submits early -- it used to ship a transcript missing its tail', async () => {
  const hook = await startRecording()
  act(() => emit({ type: 'voice_transcript', isFinal: true, accumulated: 'partial text', transcript: 'partial text' }))
  act(() => hook.result.current.stop())

  // Deepgram emits several finals while flushing. Submitting on the first one
  // was the old race.
  act(() =>
    emit({ type: 'voice_transcript', isFinal: true, accumulated: 'partial text and more', transcript: 'and more' }),
  )

  expect(hook.result.current.state).toBe('refining')
  expect(hook.result.current.refinedText).toBe('')
})

test('salvage on timeout includes unfinalized interim words rather than dropping them', async () => {
  const hook = await startRecording()
  act(() =>
    emit({ type: 'voice_transcript', isFinal: true, accumulated: 'finalized part', transcript: 'finalized part' }),
  )
  act(() => emit({ type: 'voice_transcript', isFinal: false, transcript: 'unfinalized tail' }))
  act(() => hook.result.current.stop())

  // voice_final never arrives.
  await act(async () => {
    vi.advanceTimersByTime(2100)
  })

  await waitFor(() => expect(hook.result.current.state).toBe('submitting'))
  expect(hook.result.current.refinedText).toBe('finalized part unfinalized tail')
})

test('interim stays visible through the post-release wait so a correct transcript does not look cut off', async () => {
  const hook = await startRecording()
  act(() => emit({ type: 'voice_transcript', isFinal: false, transcript: 'still yellow' }))
  expect(hook.result.current.displayInterim).toBe('still yellow')

  act(() => hook.result.current.stop())

  expect(hook.result.current.state).toBe('refining')
  expect(hook.result.current.displayInterim).toBe('still yellow')
})

test('voice_stop is sent to the broker on release', async () => {
  const hook = await startRecording()
  act(() => hook.result.current.stop())
  await waitFor(() => {
    expect(sendWsMessage.mock.calls.some(([m]) => m?.type === 'voice_stop')).toBe(true)
  })
})
