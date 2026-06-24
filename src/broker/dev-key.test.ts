import { describe, expect, it } from 'bun:test'
import { DEV_KEY_PREFIX, mintDevKey, verifyDevKey } from './dev-key'

const SECRET = 'a'.repeat(64)
const OTHER_SECRET = 'b'.repeat(64)
const enabled = { secret: SECRET, enabled: true }

describe('mintDevKey / verifyDevKey -- round trip', () => {
  it('mints a dvk_ prefixed token that verifies back to the user', () => {
    const token = mintDevKey({ user: 'jonas', ttlSec: 3600, secret: SECRET })
    expect(token.startsWith(DEV_KEY_PREFIX)).toBe(true)
    expect(verifyDevKey(token, enabled)).toEqual({ user: 'jonas' })
  })

  it('impersonates any user name', () => {
    const token = mintDevKey({ user: 'lisa', ttlSec: 3600, secret: SECRET })
    expect(verifyDevKey(token, enabled)).toEqual({ user: 'lisa' })
  })

  it('never leaks the signing secret into the token', () => {
    const token = mintDevKey({ user: 'jonas', ttlSec: 3600, secret: SECRET })
    expect(token).not.toContain(SECRET)
  })
})

describe('verifyDevKey -- flag gating (prod safety)', () => {
  it('rejects a perfectly valid token when the feature is disabled', () => {
    const token = mintDevKey({ user: 'jonas', ttlSec: 3600, secret: SECRET })
    expect(verifyDevKey(token, { secret: SECRET, enabled: false })).toBeNull()
  })
})

describe('verifyDevKey -- expiry', () => {
  it('rejects an expired token', () => {
    const past = 1_000_000
    const token = mintDevKey({ user: 'jonas', ttlSec: 60, secret: SECRET, now: past })
    // now is well past exp (past + 60s)
    expect(verifyDevKey(token, { ...enabled, now: past + 61_000 })).toBeNull()
  })

  it('accepts a token still within its TTL', () => {
    const t0 = 1_000_000
    const token = mintDevKey({ user: 'jonas', ttlSec: 60, secret: SECRET, now: t0 })
    expect(verifyDevKey(token, { ...enabled, now: t0 + 30_000 })).toEqual({ user: 'jonas' })
  })
})

describe('verifyDevKey -- signature integrity', () => {
  it('rejects a token signed with a different secret', () => {
    const token = mintDevKey({ user: 'jonas', ttlSec: 3600, secret: OTHER_SECRET })
    expect(verifyDevKey(token, enabled)).toBeNull()
  })

  it('rejects a tampered user (re-encoded payload, original signature)', () => {
    const token = mintDevKey({ user: 'jonas', ttlSec: 3600, secret: SECRET })
    const [, sig] = token.split('.')
    const forgedPayload = { u: 'admin', exp: Date.now() + 3600_000, s: 'dev-harness' }
    const forgedBody = DEV_KEY_PREFIX + Buffer.from(JSON.stringify(forgedPayload)).toString('base64url')
    const forged = `${forgedBody}.${sig}`
    expect(verifyDevKey(forged, enabled)).toBeNull()
  })

  it('rejects a malformed token', () => {
    expect(verifyDevKey('not-a-token', enabled)).toBeNull()
    expect(verifyDevKey('dvk_only-one-part', enabled)).toBeNull()
    expect(verifyDevKey('dvk_a.b.c', enabled)).toBeNull()
    expect(verifyDevKey('', enabled)).toBeNull()
  })

  it('rejects a non-dev-key token (real session-token shape)', () => {
    expect(verifyDevKey('sometoken.somesig', enabled)).toBeNull()
  })

  it('rejects a wrong-scope payload even if correctly signed', () => {
    // hand-build a correctly-signed token whose scope is NOT dev-harness
    const evilPayload = { u: 'jonas', exp: Date.now() + 3600_000, s: 'other' }
    const body = DEV_KEY_PREFIX + Buffer.from(JSON.stringify(evilPayload)).toString('base64url')
    const { createHmac } = require('node:crypto')
    const sig = createHmac('sha256', SECRET).update(body).digest('base64url')
    expect(verifyDevKey(`${body}.${sig}`, enabled)).toBeNull()
  })
})

describe('mintDevKey -- input guards', () => {
  it('throws without a user', () => {
    expect(() => mintDevKey({ user: '', ttlSec: 3600, secret: SECRET })).toThrow()
  })
  it('throws without a secret', () => {
    expect(() => mintDevKey({ user: 'jonas', ttlSec: 3600, secret: '' })).toThrow()
  })
  it('throws on a non-positive ttl', () => {
    expect(() => mintDevKey({ user: 'jonas', ttlSec: 0, secret: SECRET })).toThrow()
  })
})
