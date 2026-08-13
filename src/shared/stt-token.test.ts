/**
 * The broker signs these and a Cloudflare Worker verifies them, so a regression
 * here is a production outage with no local reproduction. Everything below runs
 * on WebCrypto only -- the same code path both runtimes take.
 */

import { describe, expect, it } from 'bun:test'
import { STT_TOKEN_TTL_MS, signSttToken, verifySttToken } from './stt-token'

const SECRET = 'test-secret-not-a-real-one'
const NOW = 1_800_000_000_000

const mint = (over: Partial<{ user: string; exp: number }> = {}, secret = SECRET) =>
  signSttToken({ user: over.user ?? 'jonas', exp: over.exp ?? NOW + STT_TOKEN_TTL_MS }, secret)

describe('signSttToken / verifySttToken', () => {
  it('round-trips the claims', async () => {
    const claims = await verifySttToken(await mint(), SECRET, NOW)
    expect(claims?.user).toBe('jonas')
    expect(claims?.exp).toBe(NOW + STT_TOKEN_TTL_MS)
  })

  it('is URL-safe -- it has to survive a query string untouched', async () => {
    // A browser cannot set a WS header, so this token travels in the query
    // string; base64 with +/= would be mangled or need escaping.
    const token = await mint({ user: 'user+with/odd=chars' })
    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/)
    expect(await verifySttToken(token, SECRET, NOW)).not.toBeNull()
  })

  it('rejects a token signed with a different secret', async () => {
    expect(await verifySttToken(await mint({}, 'other-secret'), SECRET, NOW)).toBeNull()
  })

  it('rejects an expired token', async () => {
    const token = await mint({ exp: NOW - 1 })
    expect(await verifySttToken(token, SECRET, NOW)).toBeNull()
  })

  it('accepts right up to the expiry and not past it', async () => {
    const token = await mint({ exp: NOW + 1000 })
    expect(await verifySttToken(token, SECRET, NOW + 999)).not.toBeNull()
    expect(await verifySttToken(token, SECRET, NOW + 1000)).toBeNull()
  })

  it('rejects a tampered payload -- the whole point of signing it', async () => {
    const [payload, sig] = (await mint()).split('.')
    const forged = btoa(JSON.stringify({ user: 'admin', exp: NOW + 999_999 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(payload).not.toBe(forged)
    expect(await verifySttToken(`${forged}.${sig}`, SECRET, NOW)).toBeNull()
  })

  it('rejects malformed shapes without throwing', async () => {
    for (const bad of ['', '.', 'nodot', 'a.b', '...', 'π.π']) {
      expect(await verifySttToken(bad, SECRET, NOW)).toBeNull()
    }
  })

  it('rejects a validly-signed payload that is not a claims object', async () => {
    // Signed by us, but garbage inside -- verification must check both.
    const ENCODER = new TextEncoder()
    const payload = btoa('{"nope":1}').replace(/=+$/, '')
    const key = await crypto.subtle.importKey('raw', ENCODER.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ])
    const raw = new Uint8Array(await crypto.subtle.sign('HMAC', key, ENCODER.encode(payload)))
    let binary = ''
    for (const b of raw) binary += String.fromCharCode(b)
    const sig = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(await verifySttToken(`${payload}.${sig}`, SECRET, NOW)).toBeNull()
  })
})
