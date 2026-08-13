/**
 * voice-stt-token - mint + CACHE the short-lived token the browser presents to
 * the STT Worker.
 *
 * WHAT THIS REPLACED. The previous version fetched a DEEPGRAM token, and the
 * broker served it by calling api.deepgram.com/v1/auth/grant -- a trans-Pacific
 * round trip that measured **838-2718ms** in production logs, sitting directly
 * in front of the user's key press. The broker now signs an HMAC locally, so the
 * same request is a local round trip and the cache below is belt-and-braces
 * rather than the thing holding the feature up.
 *
 * The token only has to be valid at WS-CONNECT time, so it is cached for its
 * lifetime and pre-warmed with the mic; a warm press pays 0ms.
 */

/** Re-mint this far before real expiry so a token never dies mid-connect. */
const REFRESH_MARGIN_MS = 45_000

interface SttToken {
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
async function fetchSttToken(): Promise<SttToken> {
  const res = await fetch('/api/voice/stt-token', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
    throw new Error(body.error ?? `stt token mint failed (${res.status})`)
  }
  return (await res.json()) as SttToken
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
export function getSttToken(): Promise<string> {
  if (cacheIsUsable()) return Promise.resolve((cached as CachedToken).accessToken)
  if (inflight) return inflight
  const t0 = performance.now()
  inflight = fetchSttToken()
    .then(tok => {
      const lifeMs = Math.max(0, tok.expiresIn * 1000 - REFRESH_MARGIN_MS)
      cached = { accessToken: tok.accessToken, usableUntil: performance.now() + lifeMs }
      console.log(`[voice] stt token minted in ${(performance.now() - t0).toFixed(0)}ms (ttl ${tok.expiresIn}s)`)
      return tok.accessToken
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Fire-and-forget pre-mint, so the press pays no mint latency. */
export function prewarmSttToken(): void {
  if (cacheIsUsable() || inflight) return
  getSttToken().catch(err => console.warn('[voice] stt token prewarm failed:', err))
}
