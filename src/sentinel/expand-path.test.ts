import { describe, expect, it } from 'bun:test'
import { expandPath } from './expand-path'

const ROOT = '/spawn/root'

describe('expandPath', () => {
  it('resolves a claude:// project URI to its absolute path segment', () => {
    expect(expandPath('claude://default/Users/jonas/proj', ROOT)).toBe('/Users/jonas/proj')
  })

  it('resolves a daemon:// project URI the same way (URI-aware, scheme-agnostic path)', () => {
    expect(expandPath('daemon://host/var/www/app', ROOT)).toBe('/var/www/app')
  })

  it('resolves a URI with an empty authority (triple slash)', () => {
    expect(expandPath('claude:///Users/jonas/x', ROOT)).toBe('/Users/jonas/x')
  })

  it('passes an absolute path through verbatim', () => {
    expect(expandPath('/abs/path', ROOT)).toBe('/abs/path')
  })

  it('resolves a relative path against the spawnRoot', () => {
    expect(expandPath('rel/dir', ROOT)).toBe('/spawn/root/rel/dir')
  })

  it('expands a ~-relative path against $HOME', () => {
    const prevHome = process.env.HOME
    process.env.HOME = '/home/tester'
    try {
      expect(expandPath('~/work', ROOT)).toBe('/home/tester/work')
      expect(expandPath('~', ROOT)).toBe('/home/tester')
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
    }
  })

  it('treats an unparseable `://` string as a literal path (no throw)', () => {
    // A malformed pseudo-URI must not crash the spawn path; it falls through to
    // the normal (relative) resolution against spawnRoot.
    const out = expandPath('not a uri ://', ROOT)
    expect(typeof out).toBe('string')
  })
})
