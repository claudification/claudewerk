/**
 * Regression tests for the pinned-device fallback in openMicStream.
 *
 * THE INCIDENT (2026-08-12, iPad): after the app hard-reloaded itself, every
 * voice attempt died instantly. We pin the resolved deviceId on first success
 * (`pinResolvedDevice`), so every later acquire carries
 * `deviceId: {exact: <id>}`. The fallback that drops the pin only fired on
 * OverconstrainedError -- but a browser that refuses a pinned device throws
 * NotAllowedError, so the retry never happened and a recoverable failure
 * surfaced as a dead mic.
 *
 * (The iPad's own root cause turned out to be the iPadOS standalone-PWA
 * permission store -- a bare {audio:true} failed identically. This fallback is
 * still wrong on its own terms: a pin we chose ourselves must never be the
 * reason the user cannot record.)
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const prefs = {
  voiceDeviceId: '',
  voiceNoiseSuppression: false,
  keepMicOpen: false,
  voiceWarmStreamMs: 30_000,
}
const updateControlPanelPrefs = vi.fn()

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: {
    getState: () => ({ controlPanelPrefs: prefs, updateControlPanelPrefs }),
  },
}))

/** A live-looking MediaStream stub. */
function fakeStream(deviceId: string) {
  const track = {
    readyState: 'live',
    kind: 'audio',
    stop: vi.fn(),
    getSettings: () => ({ deviceId }),
  }
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
}

function micError(name: string): Error {
  const err = new Error(`${name} from getUserMedia`)
  err.name = name
  return err
}

let getUserMedia: ReturnType<typeof vi.fn>

beforeEach(() => {
  prefs.voiceDeviceId = ''
  getUserMedia = vi.fn()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      getSupportedConstraints: () => ({}),
    },
  })
})

afterEach(async () => {
  const { invalidateWarmStream } = await import('./voice-mic-stream')
  invalidateWarmStream()
  vi.clearAllMocks()
})

/** The exact deviceId carried by call n, or undefined when unpinned. */
function pinnedIdOfCall(n: number): string | undefined {
  const audio = getUserMedia.mock.calls[n]?.[0]?.audio as { deviceId?: { exact: string } } | undefined
  return audio?.deviceId?.exact
}

describe('openMicStream pinned-device fallback', () => {
  test('retries WITHOUT the pin when the pinned device is refused as NotAllowedError', async () => {
    prefs.voiceDeviceId = 'pinned-mic'
    getUserMedia.mockRejectedValueOnce(micError('NotAllowedError')).mockResolvedValueOnce(fakeStream('default-mic'))

    const { acquireMicStream } = await import('./voice-mic-stream')
    const stream = await acquireMicStream()

    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(pinnedIdOfCall(0)).toBe('pinned-mic')
    expect(pinnedIdOfCall(1)).toBeUndefined()
    expect(stream.getAudioTracks()[0]?.getSettings().deviceId).toBe('default-mic')
  })

  test('still retries on OverconstrainedError (the case that already worked)', async () => {
    prefs.voiceDeviceId = 'pinned-mic'
    getUserMedia.mockRejectedValueOnce(micError('OverconstrainedError')).mockResolvedValueOnce(fakeStream('other-mic'))

    const { acquireMicStream } = await import('./voice-mic-stream')
    await acquireMicStream()

    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(pinnedIdOfCall(1)).toBeUndefined()
  })

  test('does NOT retry when nothing was pinned -- a bare denial is the real answer', async () => {
    prefs.voiceDeviceId = ''
    getUserMedia.mockRejectedValue(micError('NotAllowedError'))

    const { acquireMicStream } = await import('./voice-mic-stream')
    await expect(acquireMicStream()).rejects.toThrow(/NotAllowedError/)

    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  test('rethrows the ORIGINAL error when the unpinned retry fails too', async () => {
    prefs.voiceDeviceId = 'pinned-mic'
    getUserMedia.mockRejectedValueOnce(micError('NotAllowedError')).mockRejectedValueOnce(micError('AbortError'))

    const { acquireMicStream } = await import('./voice-mic-stream')
    await expect(acquireMicStream()).rejects.toMatchObject({ name: 'NotAllowedError' })

    expect(getUserMedia).toHaveBeenCalledTimes(2)
  })

  test('does not retry a failure that dropping the pin cannot fix', async () => {
    prefs.voiceDeviceId = 'pinned-mic'
    getUserMedia.mockRejectedValue(micError('NotReadableError'))

    const { acquireMicStream } = await import('./voice-mic-stream')
    await expect(acquireMicStream()).rejects.toMatchObject({ name: 'NotReadableError' })

    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })
})
