/**
 * Regression test for the setTimeout leak fix at voice-key.tsx:68.
 *
 * When voice.state transitions to 'submitting', a 300ms setTimeout was
 * scheduled to reset voice state. If the component unmounts before the
 * timer fires the callback still calls voice.reset() on an unmounted
 * component. The fix captures the timer id and clears it on cleanup.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const resetMock = vi.fn()
let voiceState: 'idle' | 'submitting' | 'recording' | 'error' | 'connecting' | 'refining' = 'idle'

vi.mock('@/hooks/use-voice-recording', () => ({
  useVoiceRecording: () => ({
    state: voiceState,
    refinedText: '',
    finalText: 'hello world',
    interimText: '',
    errorMsg: '',
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    reset: resetMock,
  }),
  prewarmMicStream: vi.fn(),
  dismissMicExpired: vi.fn(),
  getMicExpired: () => false,
  subscribeMicExpired: () => () => {},
}))

vi.mock('@/hooks/use-conversations', () => ({
  sendInput: vi.fn(),
  useConversationsStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        controlPanelPrefs: { voiceHoldKey: 'Space', keepMicOpen: false },
      }),
    {
      getState: () => ({ selectedConversationId: null }),
    },
  ),
}))

vi.mock('@/lib/utils', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, haptic: vi.fn() }
})

beforeEach(() => {
  voiceState = 'idle'
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('VoiceKey setTimeout cleanup', () => {
  test('does not call voice.reset() if unmounted before 300ms timer fires', async () => {
    vi.useFakeTimers()
    voiceState = 'submitting'
    const { VoiceKey } = await import('./voice-key')
    const { unmount } = render(<VoiceKey />)
    unmount()
    vi.advanceTimersByTime(1000)
    expect(resetMock).not.toHaveBeenCalled()
  })
})
