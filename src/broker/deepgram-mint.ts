/**
 * deepgram-mint - a short-lived Deepgram access token for browser-DIRECT STT.
 *
 * KEY PROTECTION (non-negotiable): the real DEEPGRAM_API_KEY NEVER reaches the
 * browser. This runs server-side (broker), calls Deepgram's /v1/auth/grant to
 * mint a short-lived JWT, and the browser gets ONLY that token to open its live
 * WebSocket DIRECTLY to Deepgram -- no broker in the audio path. Mirrors the
 * OpenAI ephemeral-token pattern in desk/voice-mint.ts.
 *
 * The token only needs to be valid at WS-connect time (Deepgram docs:
 * developers.deepgram.com/reference/token-based-auth-api/grant-token), so a
 * short TTL is fine even for a long dictation -- the connection outlives it.
 *
 * `apiKey` and `fetcher` are parameters so this is unit-tested without network
 * and the route owns where the key comes from (process.env.DEEPGRAM_API_KEY).
 */

const GRANT_URL = 'https://api.deepgram.com/v1/auth/grant'
/**
 * Deepgram's own default is 30s. We mint 5 minutes so the browser can CACHE the
 * token across presses (voice-deepgram-token.ts) instead of paying two network
 * hops in front of every dictation. The token only has to be valid at WS-connect
 * time, and it grants nothing but STT -- 5 minutes is a modest exposure window
 * for taking the mint off the critical path entirely.
 */
const DEFAULT_TTL_SECONDS = 300
/** Deepgram accepts 1..3600s. */
const MIN_TTL_SECONDS = 1
const MAX_TTL_SECONDS = 3600

export interface MintedDeepgramToken {
  /** The JWT the browser Bearers to open its Deepgram live WebSocket. */
  accessToken: string
  /** Seconds until the token expires (only needs to outlive the initial connect). */
  expiresIn: number
}

export interface MintDeepgramOptions {
  /** Deepgram project API key -- supplied server-side from process.env, never the browser. */
  apiKey: string
  /** Token lifetime, clamped to Deepgram's 1..3600s. Default 60. */
  ttlSeconds?: number
  /** Test seam. Defaults to globalThis.fetch. */
  fetcher?: typeof fetch
}

export async function mintDeepgramToken(opts: MintDeepgramOptions): Promise<MintedDeepgramToken> {
  if (!opts.apiKey) throw new Error('DEEPGRAM_API_KEY not configured')
  const fetcher = opts.fetcher ?? globalThis.fetch
  const ttl = clampTtl(opts.ttlSeconds ?? DEFAULT_TTL_SECONDS)

  const res = await fetcher(GRANT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Token ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl_seconds: ttl }),
  })

  // fallow-ignore-next-line code-duplication -- standard fetch+error boilerplate;
  // the Deepgram grant and the OpenAI client_secrets mint are separate flows.
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`deepgram grant ${res.status}: ${detail.slice(0, 200)}`)
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error('deepgram grant: no access_token in response')
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? ttl }
}

function clampTtl(ttl: number): number {
  if (!Number.isFinite(ttl)) return DEFAULT_TTL_SECONDS
  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Math.floor(ttl)))
}
