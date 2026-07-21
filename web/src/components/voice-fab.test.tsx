/**
 * Regression test for the setTimeout leak fix at voice-fab.tsx:48.
 *
 * Before the fix: when voice.state transitioned to 'submitting', a 300ms
 * setTimeout was scheduled to reset voice + drag state. If the component
 * unmounted before the timer fired, the callback still ran and called
 * voice.reset() and several setState calls on an unmounted component.
 *
 * After the fix: the effect captures the timer id and clears it on cleanup.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const resetMock = vi.fn()
const sendInputMock = vi.fn()
let voiceState: 'idle' | 'submitting' | 'recording' | 'error' | 'connecting' | 'refining' = 'idle'
let targetConversationId: string | null = null

vi.mock('@/hooks/use-voice-recording', () => ({
  useVoiceRecording: () => ({
    state: voiceState,
    refinedText: '',
    finalText: 'hello world',
    interimText: '',
    displayInterim: '',
    errorMsg: '',
    targetConversationId,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    reset: resetMock,
  }),
}))

vi.mock('@/hooks/use-conversations', () => ({
  sendInput: sendInputMock,
  useConversationsStore: Object.assign(() => ({}), {
    // The LIVE selection. The bug was submitting here instead of the pinned target.
    getState: () => ({ selectedConversationId: 'live-other-conversation' }),
  }),
}))

vi.mock('@/lib/utils', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, haptic: vi.fn() }
})

// Mock navigator.permissions for jsdom
beforeEach(() => {
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: vi.fn().mockResolvedValue({ state: 'granted', onchange: null }) },
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
  voiceState = 'idle'
  targetConversationId = null
})

describe('VoiceFab setTimeout cleanup', () => {
  test('does not call voice.reset() if unmounted before 300ms timer fires', async () => {
    vi.useFakeTimers()
    voiceState = 'submitting'
    const { VoiceFab } = await import('./voice-fab')
    const { unmount } = render(<VoiceFab />)
    // Effect ran on mount; setTimeout(300) is now pending.
    unmount()
    // Advance well past the 300ms timeout; cleanup should have cleared it.
    vi.advanceTimersByTime(1000)
    expect(resetMock).not.toHaveBeenCalled()
  })
})

describe('VoiceFab submit target', () => {
  // Regression: releasing the button then switching conversations during the
  // refinement delay submitted to the newly-selected conversation. The message
  // must go to the conversation that was active when recording started.
  test('submits to the pinned target conversation, not the live selection', async () => {
    targetConversationId = 'recorded-in-this-conversation'
    voiceState = 'submitting'
    const { VoiceFab } = await import('./voice-fab')
    render(<VoiceFab />)
    expect(sendInputMock).toHaveBeenCalledTimes(1)
    expect(sendInputMock).toHaveBeenCalledWith('recorded-in-this-conversation', 'hello world')
  })

  test('does not submit when no target was pinned', async () => {
    targetConversationId = null
    voiceState = 'submitting'
    const { VoiceFab } = await import('./voice-fab')
    render(<VoiceFab />)
    expect(sendInputMock).not.toHaveBeenCalled()
  })
})
