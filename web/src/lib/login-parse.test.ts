import { describe, expect, it } from 'bun:test'
import { extractAccount, extractAuthUrl, formatAccount, parsePastedCode, validatePastedCode } from './login-parse'

const AUTHORIZE = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=STATE123&code_challenge=y'

describe('extractAuthUrl', () => {
  it('pulls the manual url + state from a flat response', () => {
    expect(extractAuthUrl({ manualUrl: AUTHORIZE, automaticUrl: 'http://localhost:5/callback' })).toEqual({
      url: AUTHORIZE,
      state: 'STATE123',
    })
  })

  it('unwraps a nested response shape', () => {
    expect(extractAuthUrl({ response: { manualUrl: AUTHORIZE } }).state).toBe('STATE123')
  })

  it('falls back to `url` and tolerates a stateless / unparseable url', () => {
    expect(extractAuthUrl({ url: 'not a url' })).toEqual({ url: 'not a url', state: '' })
  })

  it('throws when no url is present', () => {
    expect(() => extractAuthUrl({})).toThrow('no authorization URL')
  })
})

describe('parsePastedCode', () => {
  it('returns a bare code untouched', () => {
    expect(parsePastedCode('  abc123 ')).toEqual({ code: 'abc123' })
  })

  it('extracts code + state from a full callback URL', () => {
    expect(parsePastedCode('https://platform.claude.com/oauth/code/callback?code=THECODE&state=STATE123')).toEqual({
      code: 'THECODE',
      state: 'STATE123',
    })
  })

  it('parses a bare query string without a scheme', () => {
    expect(parsePastedCode('code=THECODE&state=S')).toEqual({ code: 'THECODE', state: 'S' })
  })
})

describe('validatePastedCode', () => {
  it('returns the code when state matches', () => {
    expect(validatePastedCode('code=THECODE&state=S', 'S')).toBe('THECODE')
  })

  it('accepts a bare code (no state to check)', () => {
    expect(validatePastedCode('BARECODE', 'S')).toBe('BARECODE')
  })

  it('rejects a state mismatch (CSRF / stale url)', () => {
    expect(() => validatePastedCode('code=X&state=OTHER', 'MINE')).toThrow('state mismatch')
  })

  it('rejects an empty paste', () => {
    expect(() => validatePastedCode('   ', 'S')).toThrow('no authorization code')
  })
})

describe('extractAccount', () => {
  it('narrows the account block', () => {
    expect(extractAccount({ account: { email: 'jonas@duplo.org', subscriptionType: 'Claude Max', extra: 1 } })).toEqual(
      { email: 'jonas@duplo.org', subscriptionType: 'Claude Max' },
    )
  })

  it('is defensive against a missing / malformed account', () => {
    expect(extractAccount(null)).toEqual({ email: undefined, subscriptionType: undefined })
  })
})

describe('formatAccount', () => {
  it('joins email + subscription', () => {
    expect(formatAccount({ email: 'a@b.c', subscriptionType: 'Claude Max' })).toBe('a@b.c -- Claude Max')
  })

  it('email only', () => {
    expect(formatAccount({ email: 'a@b.c' })).toBe('a@b.c')
  })

  it('falls back when empty', () => {
    expect(formatAccount({})).toBe('Logged in')
  })
})
