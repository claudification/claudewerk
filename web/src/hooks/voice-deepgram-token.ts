/**
 * voice-deepgram-token - mint a short-lived Deepgram access token from the broker.
 *
 * The real DEEPGRAM_API_KEY never leaves the server (see src/broker/deepgram-mint.ts);
 * the browser only ever holds a token that expires in seconds. Kept apart from
 * voice-deepgram-direct.ts because minting is an authed HTTP concern with its own
 * failure modes, while that file is purely the live streaming session.
 */

export interface DeepgramToken {
  accessToken: string
  expiresIn: number
}

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
