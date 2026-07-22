import { describe, expect, it } from 'bun:test'
import { mintDeepgramToken } from './deepgram-mint'

function fakeFetch(status: number, body: unknown, capture?: (url: string, init: RequestInit) => void) {
  return (async (url: string, init: RequestInit) => {
    capture?.(url, init)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as Response
  }) as unknown as typeof fetch
}

describe('mintDeepgramToken', () => {
  it('mints a token and returns ONLY the ephemeral fields (never the api key)', async () => {
    let seenAuth = ''
    const fetcher = fakeFetch(200, { access_token: 'jwt-abc', expires_in: 60 }, (_u, init) => {
      seenAuth = (init.headers as Record<string, string>).Authorization
    })
    const out = await mintDeepgramToken({ apiKey: 'SECRET_KEY', fetcher })
    expect(out).toEqual({ accessToken: 'jwt-abc', expiresIn: 60 })
    // The real key rides the server->Deepgram Authorization header, and is NOT in the result.
    expect(seenAuth).toBe('Token SECRET_KEY')
    expect(JSON.stringify(out)).not.toContain('SECRET_KEY')
  })

  it('hits the grant endpoint with the ttl in the body, clamped to 1..3600', async () => {
    let seenUrl = '', seenBody: unknown = null
    const fetcher = fakeFetch(200, { access_token: 't', expires_in: 3600 }, (u, init) => {
      seenUrl = u
      seenBody = JSON.parse(init.body as string)
    })
    await mintDeepgramToken({ apiKey: 'k', ttlSeconds: 99999, fetcher })
    expect(seenUrl).toBe('https://api.deepgram.com/v1/auth/grant')
    expect(seenBody).toEqual({ ttl_seconds: 3600 })

    await mintDeepgramToken({ apiKey: 'k', ttlSeconds: 0, fetcher })
    expect(seenBody).toEqual({ ttl_seconds: 1 })
  })

  it('defaults ttl to 60s when unspecified', async () => {
    let seenBody: unknown = null
    const fetcher = fakeFetch(200, { access_token: 't', expires_in: 60 }, (_u, init) => {
      seenBody = JSON.parse(init.body as string)
    })
    await mintDeepgramToken({ apiKey: 'k', fetcher })
    expect(seenBody).toEqual({ ttl_seconds: 60 })
  })

  it('throws without an api key (never calls out)', async () => {
    await expect(mintDeepgramToken({ apiKey: '' })).rejects.toThrow('DEEPGRAM_API_KEY not configured')
  })

  it('surfaces a non-2xx grant failure with status + detail', async () => {
    const fetcher = fakeFetch(403, 'forbidden')
    await expect(mintDeepgramToken({ apiKey: 'k', fetcher })).rejects.toThrow('deepgram grant 403')
  })

  it('throws when the response has no access_token', async () => {
    const fetcher = fakeFetch(200, { expires_in: 60 })
    await expect(mintDeepgramToken({ apiKey: 'k', fetcher })).rejects.toThrow('no access_token')
  })
})
