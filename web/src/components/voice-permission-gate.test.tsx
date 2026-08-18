/**
 * Regression tests for the 2026-08-12 iPad incident.
 *
 * Two separate failures, one root cause (nobody owned the permission question):
 *
 *  1. VoiceFab did `if (micPermission === 'denied') return null`, so a single
 *     refusal DELETED the button for the rest of the page's life. On iPadOS the
 *     grant does not survive a reload, so this fired routinely and the user was
 *     left with no mic button and no explanation.
 *  2. VoiceKey (push-to-talk) had no gate at all and called voice.start()
 *     straight from keydown, so a refusal surfaced as WebKit's raw DOMException
 *     text instead of an unlock attempt.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CHORD_GRACE_MS } from '@/hooks/push-to-talk-guard'

const startMock = vi.fn()
const unlockMock = vi.fn()
let permissionState: 'unknown' | 'prompt' | 'granted' | 'denied' = 'granted'
let permissionError = ''

vi.mock('@/hooks/use-mic-permission', () => ({
  useMicPermission: () => ({
    state: permissionState,
    needsUnlock: permissionState !== 'granted',
    unlock: unlockMock,
    error: permissionError,
    clearError: vi.fn(),
  }),
}))

vi.mock('@/hooks/use-voice-recording', () => ({
  useVoiceRecording: () => ({
    state: 'idle' as const,
    backendReady: false,
    refinedText: '',
    finalText: '',
    interimText: '',
    displayInterim: '',
    errorMsg: '',
    targetConversationId: null,
    start: startMock,
    stop: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
  }),
  dismissMicExpired: vi.fn(),
  getMicExpired: () => false,
  subscribeMicExpired: () => () => {},
}))

vi.mock('@/hooks/voice-prewarm', () => ({ prewarmVoice: vi.fn(), prewarmVoiceTransport: vi.fn() }))

vi.mock('@/hooks/use-conversations', () => ({
  sendInput: vi.fn(),
  useConversationsStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ controlPanelPrefs: { voiceHoldKey: 'AltRight', keepMicOpen: false } }),
    { getState: () => ({ selectedConversationId: 'conv-1' }) },
  ),
}))

vi.mock('@/lib/utils', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, haptic: vi.fn() }
})

beforeEach(() => {
  permissionState = 'granted'
  permissionError = ''
  unlockMock.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('VoiceFab survives a mic refusal', () => {
  test('still renders a tappable button when permission is denied', async () => {
    permissionState = 'denied'
    const { VoiceFab } = await import('./voice-fab')
    render(<VoiceFab />)

    const button = screen.getByRole('button', { name: /microphone blocked/i })
    expect(button).toBeTruthy()
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  test('a tap on the blocked button retries the unlock instead of doing nothing', async () => {
    permissionState = 'denied'
    const { VoiceFab } = await import('./voice-fab')
    render(<VoiceFab />)

    fireEvent.pointerDown(screen.getByRole('button', { name: /microphone blocked/i }))

    expect(unlockMock).toHaveBeenCalledTimes(1)
    expect(startMock).not.toHaveBeenCalled()
  })

  test('shows the refusal reason rather than swallowing it', async () => {
    permissionState = 'denied'
    permissionError = 'Mic blocked by iOS. Open this in Safari, or re-add the Home Screen app.'
    const { VoiceFab } = await import('./voice-fab')
    render(<VoiceFab />)

    expect(screen.getByText(/open this in safari/i)).toBeTruthy()
  })

  test('records normally once permission is granted', async () => {
    permissionState = 'granted'
    const { VoiceFab } = await import('./voice-fab')
    render(<VoiceFab />)

    const button = screen.getByRole('button', { name: /hold to record/i })
    // jsdom has no pointer capture; the component calls it on the event target.
    ;(button as HTMLElement).setPointerCapture = vi.fn()
    fireEvent.pointerDown(button, { pointerId: 1, clientX: 0 })

    expect(startMock).toHaveBeenCalledTimes(1)
    expect(unlockMock).not.toHaveBeenCalled()
  })
})

describe('VoiceKey push-to-talk is gated', () => {
  test('an ungranted key press unlocks instead of diving into the recorder', async () => {
    permissionState = 'prompt'
    const { VoiceKey } = await import('./voice-key')
    render(<VoiceKey />)

    fireEvent.keyDown(window, { code: 'AltRight' })

    expect(unlockMock).toHaveBeenCalledTimes(1)
    expect(startMock).not.toHaveBeenCalled()
  })

  test('the matching keyup after an unlock press is a no-op', async () => {
    permissionState = 'prompt'
    const { VoiceKey } = await import('./voice-key')
    const { container } = render(<VoiceKey />)

    fireEvent.keyDown(window, { code: 'AltRight' })
    fireEvent.keyUp(window, { code: 'AltRight' })

    expect(startMock).not.toHaveBeenCalled()
    expect(container).toBeTruthy()
  })

  test('a granted key press records, once the chord-grace window elapses', async () => {
    // The start is deliberately held for CHORD_GRACE_MS so that a hold which
    // turns out to be the first half of a chord (Pulse peeks on mod+alt) never
    // opens the mic. See push-to-talk-guard.ts.
    permissionState = 'granted'
    const { VoiceKey } = await import('./voice-key')
    render(<VoiceKey />)

    fireEvent.keyDown(window, { code: 'AltRight' })
    expect(startMock).not.toHaveBeenCalled()

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, CHORD_GRACE_MS + 10))
    })

    expect(startMock).toHaveBeenCalledTimes(1)
    expect(unlockMock).not.toHaveBeenCalled()
  })

  test('a press that becomes a chord never opens the mic', async () => {
    permissionState = 'granted'
    const { VoiceKey } = await import('./voice-key')
    render(<VoiceKey />)

    fireEvent.keyDown(window, { code: 'AltRight' })
    fireEvent.keyDown(window, { code: 'MetaLeft', altKey: true, metaKey: true })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, CHORD_GRACE_MS + 10))
    })

    expect(startMock).not.toHaveBeenCalled()
  })

  test('surfaces a permission refusal in the banner while idle', async () => {
    permissionState = 'denied'
    permissionError = 'Mic blocked by iOS. Open this in Safari, or re-add the Home Screen app.'
    const { VoiceKey } = await import('./voice-key')
    render(<VoiceKey />)

    expect(screen.getByText(/open this in safari/i)).toBeTruthy()
  })
})
