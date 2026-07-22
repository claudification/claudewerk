/**
 * The token mint used to sit on the critical path: `await fetchDeepgramToken()`
 * ran AFTER the mic opened and BEFORE the socket was dialled, so every press paid
 * two network hops (browser -> broker -> Deepgram grant) before a single word
 * could be transcribed. It is now cached for its lifetime and pre-warmable.
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  deepgramTokenIsWarm,
  fetchDeepgramToken,
  getDeepgramToken,
  invalidateDeepgramToken,
  prewarmDeepgramToken,
} from '@/hooks/voice-deepgram-token'

/** Deferred so a second caller can arrive while the first mint is in flight. */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(res => (resolve = res))
  return { promise, resolve }
}

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  invalidateDeepgramToken()
  fetchMock = vi.fn(async () => okResponse({ accessToken: 'jwt-1', expiresIn: 300 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  invalidateDeepgramToken()
  vi.unstubAllGlobals()
})

test('mints once and serves later presses from cache', async () => {
  expect(await getDeepgramToken()).toBe('jwt-1')
  expect(deepgramTokenIsWarm()).toBe(true)
  expect(await getDeepgramToken()).toBe('jwt-1')

  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('a prewarm racing a press shares one mint, not two', async () => {
  const gate = deferred<Response>()
  fetchMock.mockReturnValueOnce(gate.promise)

  const first = getDeepgramToken()
  const second = getDeepgramToken()
  gate.resolve(okResponse({ accessToken: 'jwt-shared', expiresIn: 300 }))

  expect(await first).toBe('jwt-shared')
  expect(await second).toBe('jwt-shared')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('re-mints when the remaining life is inside the refresh margin', async () => {
  // 45s TTL is entirely consumed by the 45s margin -- never safe to reuse.
  fetchMock.mockResolvedValue(okResponse({ accessToken: 'jwt-short', expiresIn: 45 }))

  await getDeepgramToken()
  expect(deepgramTokenIsWarm()).toBe(false)
  await getDeepgramToken()

  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('invalidate forces the next call to mint again', async () => {
  await getDeepgramToken()
  invalidateDeepgramToken()
  expect(deepgramTokenIsWarm()).toBe(false)
  await getDeepgramToken()

  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('a failed mint is not cached and does not wedge later attempts', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ error: 'grant 502' }) } as Response)

  await expect(getDeepgramToken()).rejects.toThrow('grant 502')
  expect(deepgramTokenIsWarm()).toBe(false)
  expect(await getDeepgramToken()).toBe('jwt-1')
})

test('prewarm swallows failures -- it must never surface as a user error', async () => {
  fetchMock.mockRejectedValueOnce(new Error('offline'))
  prewarmDeepgramToken()
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
  expect(deepgramTokenIsWarm()).toBe(false)
})

test('prewarm is a no-op once a token is already warm', async () => {
  await getDeepgramToken()
  prewarmDeepgramToken()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('an unconfigured broker reports the missing key, not a bare status', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 503,
    json: async () => ({ code: 'voice_unconfigured' }),
  } as Response)

  await expect(fetchDeepgramToken()).rejects.toThrow('no Deepgram key configured')
})
