/**
 * Tier 1 unit tests for `oauth-token` -- profile token discovery: the macOS
 * keychain suffix scheme for alt profiles, multi-store fallback, and the
 * freshest-wins selection across keychain / `.credentials.json` / legacy.
 *
 * All side effects (keychain shell-out, fs) go through DI seams so the tests
 * stay hermetic -- no real keychain, no real home.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getOAuthToken, type KeychainProbe, keychainServiceFor } from './oauth-token'

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'oauth-token-home-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

// ─── keychainServiceFor ────────────────────────────────────────────

describe('keychainServiceFor', () => {
  test('default profile gets the bare service name', () => {
    expect(keychainServiceFor(join(home, '.claude'), home)).toBe('Claude Code-credentials')
  })

  test('alt profile gets sha256(configDir).slice(0,8) suffix', () => {
    // Matches what `security dump-keychain` actually contains for an alt
    // profile: empirically `~/.claude-work` resolves to
    // `Claude Code-credentials-0be8b895` on Jonas's machine -- this test
    // pins the hashing scheme so a refactor can't silently break it.
    expect(keychainServiceFor('/Users/jonas/.claude-work', '/Users/jonas')).toBe('Claude Code-credentials-0be8b895')
  })

  test('alt profile suffix is deterministic across calls', () => {
    const a = keychainServiceFor('/some/path/.claude-alt', home)
    const b = keychainServiceFor('/some/path/.claude-alt', home)
    expect(a).toBe(b)
    expect(a).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
  })
})

// ─── getOAuthToken ─────────────────────────────────────────────────

describe('getOAuthToken (darwin, keychain)', () => {
  test('reads default-profile token from the bare keychain entry', () => {
    const probe: KeychainProbe = service =>
      service === 'Claude Code-credentials' ? JSON.stringify({ claudeAiOauth: { accessToken: 'sk-default' } }) : null
    expect(getOAuthToken(join(home, '.claude'), { home, platform: 'darwin', keychain: probe })).toBe('sk-default')
  })

  test('reads alt-profile token from the suffixed keychain entry', () => {
    const altConfigDir = join(home, '.claude-work')
    const expectedService = keychainServiceFor(altConfigDir, home)
    const probe: KeychainProbe = service =>
      service === expectedService ? JSON.stringify({ claudeAiOauth: { accessToken: 'sk-work' } }) : null
    expect(getOAuthToken(altConfigDir, { home, platform: 'darwin', keychain: probe })).toBe('sk-work')
  })

  test('returns null when keychain has no entry and no fallback files exist', () => {
    expect(
      getOAuthToken(join(home, '.claude-empty'), {
        home,
        platform: 'darwin',
        keychain: () => null,
      }),
    ).toBeNull()
  })

  test('falls through to <configDir>/.credentials.json on darwin when keychain misses', () => {
    const altConfigDir = join(home, '.claude-file')
    mkdirSync(altConfigDir, { recursive: true })
    writeFileSync(
      join(altConfigDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-from-file' } }),
    )
    expect(
      getOAuthToken(altConfigDir, {
        home,
        platform: 'darwin',
        keychain: () => null,
      }),
    ).toBe('sk-from-file')
  })

  test('keychain blob that is not JSON returns null and falls through cleanly', () => {
    const altConfigDir = join(home, '.claude-bad')
    expect(
      getOAuthToken(altConfigDir, {
        home,
        platform: 'darwin',
        keychain: () => 'not-json',
      }),
    ).toBeNull()
  })

  // FRESHEST WINS: the default profile drifts between the keychain (interactive
  // CC) and .credentials.json (file-auth spawns). The poller must pick whichever
  // store was refreshed most recently, not just "keychain first".
  test('prefers the fresher .credentials.json token over a stale keychain token', () => {
    const cfgDir = join(home, '.claude-fresh-file')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(
      join(cfgDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-fresh-file', expiresAt: 2000 } }),
    )
    const probe: KeychainProbe = () =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-stale-keychain', expiresAt: 1000 } })
    expect(getOAuthToken(cfgDir, { home, platform: 'darwin', keychain: probe })).toBe('sk-fresh-file')
  })

  test('prefers the fresher keychain token over a stale .credentials.json token', () => {
    const cfgDir = join(home, '.claude-fresh-keychain')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(
      join(cfgDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-stale-file', expiresAt: 1000 } }),
    )
    const probe: KeychainProbe = () =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-fresh-keychain', expiresAt: 2000 } })
    expect(getOAuthToken(cfgDir, { home, platform: 'darwin', keychain: probe })).toBe('sk-fresh-keychain')
  })

  test('on an expiry tie (or no expiry recorded) keychain priority wins', () => {
    const cfgDir = join(home, '.claude-tie')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-file' } }))
    const probe: KeychainProbe = () => JSON.stringify({ claudeAiOauth: { accessToken: 'sk-keychain' } })
    expect(getOAuthToken(cfgDir, { home, platform: 'darwin', keychain: probe })).toBe('sk-keychain')
  })
})

describe('getOAuthToken (linux / no keychain)', () => {
  test('skips keychain on non-darwin and reads .credentials.json', () => {
    const cfgDir = join(home, '.claude')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, '.credentials.json'), JSON.stringify({ accessToken: 'sk-linux' }))
    expect(
      getOAuthToken(cfgDir, {
        home,
        platform: 'linux',
        // No keychain dep needed -- darwin branch skipped.
      }),
    ).toBe('sk-linux')
  })

  test('default profile falls back to ~/.claude.json legacy', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accessToken: 'sk-legacy' } }))
    expect(getOAuthToken(join(home, '.claude'), { home, platform: 'linux' })).toBe('sk-legacy')
  })

  test('alt profile does NOT consult ~/.claude.json legacy (default-only)', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accessToken: 'sk-legacy' } }))
    expect(getOAuthToken(join(home, '.claude-alt'), { home, platform: 'linux' })).toBeNull()
  })

  test('returns null and never throws when everything is missing', () => {
    expect(getOAuthToken('/nonexistent', { home, platform: 'linux' })).toBeNull()
  })
})
