/**
 * voice-deepgram-token - mint + CACHE the short-lived Deepgram access token.
 *
 * The mint is two network hops (browser -> broker -> api.deepgram.com/v1/auth/grant).
 * Doing it on the critical path after the mic opens put those hops between the
 * user pressing the key and any audio reaching Deepgram -- the "mic opens, then
 * nothing is transcribed until way later" bug. The token only has to be valid at
 * WS-CONNECT time, so it is cached for its lifetime and pre-warmed alongside the
 * mic; a warm press pays 0ms.
 *
 * The real DEEPGRAM_API_KEY never reaches the browser (see src/broker/deepgram-mint.ts).
 */

/** Re-mint this far before real expiry so a token never dies mid-connect. */
const REFRESH_MARGIN_MS = 45_000

export interface DeepgramToken {
  accessToken: string
  expiresIn: number
}

interface CachedToken {
  accessToken: string
  /** performance.now() timestamp after which this token must not be reused. */
  usableUntil: number
}

let cached: CachedToken | null = null
let inflight: Promise<string> | null = null

/** Mint a fresh token from the broker. Bypasses the cache. */
export async function fetchDeepgramToken(): Promise<DeepgramToken> {
  // Standard authed-mint fetch+error boilerplate; intentionally separate from the
  // orb's OpenAI token mint (different endpoint + response shape).
  // fallow-ignore-next-line code-duplication
  const res = await fetch('/api/voice/deepgram-token', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
    if (body.code === 'voice_unconfigured') throw new Error('the broker has no Deepgram key configured')
    throw new Error(body.error ?? `deepgram token mint failed (${res.status})`)
  }
  return (await res.json()) as DeepgramToken
}

/** True when the cache holds a token with enough life left to open a socket. */
function cacheIsUsable(): boolean {
  return !!cached && performance.now() < cached.usableUntil
}

/**
 * The token to open the live socket with. Returns the cached one instantly when
 * it is still good; otherwise mints (de-duplicated -- a prewarm racing a press
 * shares one request).
 */
export function getDeepgramToken(): Promise<string> {
  if (cacheIsUsable()) return Promise.resolve((cached as CachedToken).accessToken)
  if (inflight) return inflight
  const t0 = performance.now()
  inflight = fetchDeepgramToken()
    .then(tok => {
      const lifeMs = Math.max(0, tok.expiresIn * 1000 - REFRESH_MARGIN_MS)
      cached = { accessToken: tok.accessToken, usableUntil: performance.now() + lifeMs }
      console.log(`[voice] deepgram token minted in ${(performance.now() - t0).toFixed(0)}ms (ttl ${tok.expiresIn}s)`)
      return tok.accessToken
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** True when a press right now would pay zero mint latency. */
export function deepgramTokenIsWarm(): boolean {
  return cacheIsUsable()
}

/** Fire-and-forget pre-mint, so the press pays no mint latency. */
export function prewarmDeepgramToken(): void {
  if (cacheIsUsable() || inflight) return
  getDeepgramToken().catch(err => console.warn('[voice] deepgram token prewarm failed:', err))
}

/** Drop the cached token (rejected by Deepgram / signed out). */
export function invalidateDeepgramToken(): void {
  cached = null
}
