import { describe, expect, it } from 'vitest'
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

  // REGRESSION: CC's manual redirect page hands back ONE blob, `code#state`. Sent
  // whole to /oauth/token it is not a code -> 400. CC's own TUI splits it first.
  it('splits the `code#state` blob CC actually hands the user', () => {
    expect(parsePastedCode('KElw7VIikQrk#9WruZL3txPR1PmPfi')).toEqual({
      code: 'KElw7VIikQrk',
      state: '9WruZL3txPR1PmPfi',
    })
  })

  it('splits a hashed code carried inside a full callback URL', () => {
    expect(parsePastedCode('https://platform.claude.com/oauth/code/callback?code=THECODE#STATE123')).toEqual({
      code: 'THECODE',
      state: 'STATE123',
    })
  })

  it('keeps an explicit state param over the hash fragment', () => {
    expect(parsePastedCode('code=THECODE#IGNORED&state=REAL')).toEqual({ code: 'THECODE', state: 'REAL' })
  })

  it('tolerates a trailing `#` with no state', () => {
    expect(parsePastedCode('BARECODE#')).toEqual({ code: 'BARECODE' })
  })
})

describe('validatePastedCode', () => {
  it('returns the code when state matches', () => {
    expect(validatePastedCode('code=THECODE&state=S', 'S')).toBe('THECODE')
  })

  it('accepts a bare code (no state to check)', () => {
    expect(validatePastedCode('BARECODE', 'S')).toBe('BARECODE')
  })

  it('returns only the code half of a `code#state` blob', () => {
    expect(validatePastedCode('THECODE#S', 'S')).toBe('THECODE')
  })

  it('rejects a `code#state` blob from a different login attempt', () => {
    expect(() => validatePastedCode('THECODE#OTHER', 'MINE')).toThrow('state mismatch')
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
