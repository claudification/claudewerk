import { describe, expect, test } from 'bun:test'
import {
  buildProjectUri,
  compareProjectConversationUri,
  compareProjectUri,
  cwdToProjectUri,
  DEFAULT_SENTINEL_NAME,
  extractProjectLabel,
  isSameProject,
  isSameProjectConversation,
  matchProjectUri,
  normalizeProjectUri,
  parseProjectUri,
  projectIdentityKey,
  tryParseProjectUri,
  validateProjectUri,
} from './project-uri'

describe('parseProjectUri', () => {
  test('parses full URI with authority', () => {
    const result = parseProjectUri('claude://studio/Users/jonas/projects/foo')
    expect(result.scheme).toBe('claude')
    expect(result.authority).toBe('studio')
    expect(result.path).toBe('/Users/jonas/projects/foo')
    expect(result.fragment).toBeUndefined()
    expect(result.raw).toBe('claude://studio/Users/jonas/projects/foo')
  })

  test('parses authority-less URI (triple slash)', () => {
    const result = parseProjectUri('claude:///Users/jonas/projects/foo')
    expect(result.scheme).toBe('claude')
    expect(result.authority).toBeUndefined()
    expect(result.path).toBe('/Users/jonas/projects/foo')
  })

  test('parses URI with fragment', () => {
    const result = parseProjectUri('claude:///path#conversation-id')
    expect(result.scheme).toBe('claude')
    expect(result.path).toBe('/path')
    expect(result.fragment).toBe('conversation-id')
  })

  test('parses wildcard', () => {
    const result = parseProjectUri('*')
    expect(result.scheme).toBe('*')
    expect(result.path).toBe('*')
    expect(result.raw).toBe('*')
  })

  test('parses scheme-wildcard', () => {
    const result = parseProjectUri('claude:*')
    expect(result.scheme).toBe('claude')
    expect(result.path).toBe('*')
    expect(result.raw).toBe('claude:*')
  })

  test('lowercases scheme', () => {
    const result = parseProjectUri('Claude:///Users/foo')
    expect(result.scheme).toBe('claude')
  })

  test('lowercases scheme-wildcard', () => {
    const result = parseProjectUri('CODEX:*')
    expect(result.scheme).toBe('codex')
  })

  test('parses codex scheme with authority', () => {
    const result = parseProjectUri('codex://beast/Users/jonas/projects/bar')
    expect(result.scheme).toBe('codex')
    expect(result.authority).toBe('beast')
    expect(result.path).toBe('/Users/jonas/projects/bar')
  })

  test('parses non-filesystem agent URI', () => {
    const result = parseProjectUri('open-claw://gateway.example.com/my-thing')
    expect(result.scheme).toBe('open-claw')
    expect(result.authority).toBe('gateway.example.com')
    expect(result.path).toBe('/my-thing')
  })

  test('throws on missing scheme', () => {
    expect(() => parseProjectUri('/Users/jonas/projects/foo')).toThrow('Invalid project URI')
  })

  test('throws on empty string', () => {
    expect(() => parseProjectUri('')).toThrow('Invalid project URI')
  })

  test('throws on garbage input', () => {
    expect(() => parseProjectUri('not a uri at all')).toThrow('Invalid project URI')
  })

  test('handles root path', () => {
    const result = parseProjectUri('claude:///')
    expect(result.scheme).toBe('claude')
    expect(result.path).toBe('/')
    expect(result.authority).toBeUndefined()
  })

  test('handles empty fragment (hash with nothing)', () => {
    const result = parseProjectUri('claude:///path#')
    expect(result.fragment).toBeUndefined()
  })

  test('preserves raw string', () => {
    const raw = 'claude://STUDIO/Users/jonas/projects/foo'
    const result = parseProjectUri(raw)
    expect(result.raw).toBe(raw)
  })

  // Regression: bug-spawn-session-not-discoverable. A chat-backend conversation
  // was registered with `project: "chat://Mistral Dophin"` (space in the
  // authority). WHATWG URL rejected it, parseProjectUri threw, and every
  // caller iterating all conversations (most visibly the broker's
  // channel_list_conversations handler) crashed -- causing list_conversations
  // to return `[]` even when ~20 conversations existed in the store.
  test('tolerates malformed authority (spaces) instead of throwing', () => {
    const result = parseProjectUri('chat://Mistral Dophin')
    expect(result.scheme).toBe('chat')
    expect(result.authority).toBe('Mistral Dophin')
    expect(result.path).toBe('/')
    expect(result.raw).toBe('chat://Mistral Dophin')
  })

  test('tolerates authority-only URI with no path', () => {
    const result = parseProjectUri('opencode://default')
    expect(result.scheme).toBe('opencode')
    expect(result.authority).toBe('default')
    expect(result.path).toBe('/')
  })

  test('still throws on genuinely garbage input (no scheme://)', () => {
    expect(() => parseProjectUri('garbage')).toThrow()
    expect(() => parseProjectUri('')).toThrow()
  })
})

describe('validateProjectUri', () => {
  test('accepts well-formed claude URI', () => {
    const r = validateProjectUri('claude://default/Users/jonas/projects/foo')
    expect(r.valid).toBe(true)
  })

  test('accepts authority-less triple-slash form', () => {
    const r = validateProjectUri('claude:///Users/jonas/projects/foo')
    expect(r.valid).toBe(true)
  })

  test('accepts opencode authority-only URI', () => {
    const r = validateProjectUri('opencode://default')
    expect(r.valid).toBe(true)
  })

  test('rejects authority with whitespace', () => {
    const r = validateProjectUri('chat://Mistral Dophin')
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toContain('invalid authority')
  })

  test('rejects empty string', () => {
    const r = validateProjectUri('')
    expect(r.valid).toBe(false)
  })

  test('rejects bare path (no scheme://)', () => {
    const r = validateProjectUri('/Users/jonas/projects/foo')
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toContain('scheme://')
  })

  test('rejects garbage', () => {
    const r = validateProjectUri('not a uri at all')
    expect(r.valid).toBe(false)
  })

  test('rejects wildcards (permission patterns, not addresses)', () => {
    expect(validateProjectUri('*').valid).toBe(false)
    expect(validateProjectUri('claude:*').valid).toBe(false)
  })

  test('rejects URIs with userinfo / port / query', () => {
    expect(validateProjectUri('claude://user:pass@host/path').valid).toBe(false)
    expect(validateProjectUri('claude://default:9999/path').valid).toBe(false)
    expect(validateProjectUri('claude://default/path?query=1').valid).toBe(false)
  })
})

describe('tryParseProjectUri', () => {
  test('returns parsed result on valid input', () => {
    const r = tryParseProjectUri('claude://default/Users/jonas')
    expect(r?.scheme).toBe('claude')
  })

  test('returns null on garbage', () => {
    expect(tryParseProjectUri('garbage')).toBeNull()
    expect(tryParseProjectUri('')).toBeNull()
  })

  test('tolerates malformed authority (no null)', () => {
    const r = tryParseProjectUri('chat://Mistral Dophin')
    expect(r?.scheme).toBe('chat')
  })
})

describe('buildProjectUri', () => {
  test('builds URI with authority', () => {
    const result = buildProjectUri({ scheme: 'claude', authority: 'studio', path: '/Users/jonas/projects/foo' })
    expect(result).toBe('claude://studio/Users/jonas/projects/foo')
  })

  test('builds claude URI with default authority when omitted', () => {
    const result = buildProjectUri({ scheme: 'claude', path: '/Users/jonas/projects/foo' })
    expect(result).toBe('claude://default/Users/jonas/projects/foo')
  })

  test('defaults non-claude URIs to default authority too', () => {
    // Every URI carries a sentinel name; the slot is uniform across schemes.
    const result = buildProjectUri({ scheme: 'codex', path: '/foo' })
    expect(result).toBe('codex://default/foo')
  })

  test('builds URI with fragment', () => {
    const result = buildProjectUri({ scheme: 'claude', path: '/path', fragment: 'conv-123' })
    expect(result).toBe('claude://default/path#conv-123')
  })

  test('lowercases scheme', () => {
    const result = buildProjectUri({ scheme: 'CLAUDE', path: '/foo' })
    expect(result).toBe('claude://default/foo')
  })

  test('round-trip: parse -> build -> parse is identity', () => {
    const uris = [
      'claude://studio/Users/jonas/projects/foo',
      'claude://default/Users/jonas/projects/foo',
      'codex://beast/projects/bar',
      'open-claw://gateway.example.com/my-thing',
      'claude://default/path#conversation-id',
    ]

    for (const uri of uris) {
      const parsed = parseProjectUri(uri)
      const built = buildProjectUri(parsed)
      const reparsed = parseProjectUri(built)
      expect(reparsed.scheme).toBe(parsed.scheme)
      expect(reparsed.authority).toBe(parsed.authority)
      expect(reparsed.path).toBe(parsed.path)
      expect(reparsed.fragment).toBe(parsed.fragment)
    }
  })
})

describe('cwdToProjectUri', () => {
  test('converts bare CWD with defaults (default sentinel authority)', () => {
    const result = cwdToProjectUri('/Users/jonas/projects/foo')
    expect(result).toBe('claude://default/Users/jonas/projects/foo')
  })

  test('converts CWD with explicit scheme and authority', () => {
    const result = cwdToProjectUri('/Users/jonas/projects/foo', 'claude', 'studio')
    expect(result).toBe('claude://studio/Users/jonas/projects/foo')
  })

  test('converts CWD with non-claude scheme (default authority filled in)', () => {
    const result = cwdToProjectUri('/Users/jonas/projects/foo', 'codex')
    expect(result).toBe('codex://default/Users/jonas/projects/foo')
  })

  test('handles root CWD', () => {
    const result = cwdToProjectUri('/')
    expect(result).toBe('claude://default/')
  })
})

describe('matchProjectUri', () => {
  const target = 'claude:///Users/jonas/projects/remote-claude'

  test('universal wildcard matches everything', () => {
    expect(matchProjectUri('*', target)).toBe(true)
    expect(matchProjectUri('*', 'codex://beast/foo')).toBe(true)
    expect(matchProjectUri('*', 'open-claw://gw/thing')).toBe(true)
  })

  test('scheme wildcard matches all URIs with that scheme', () => {
    expect(matchProjectUri('claude:*', target)).toBe(true)
    expect(matchProjectUri('claude:*', 'claude://studio/other')).toBe(true)
    expect(matchProjectUri('claude:*', 'codex://beast/foo')).toBe(false)
  })

  test('scheme wildcard is case-insensitive on scheme', () => {
    expect(matchProjectUri('CLAUDE:*', target)).toBe(true)
  })

  test('trailing /* does prefix match on path', () => {
    expect(matchProjectUri('claude:///Users/jonas/projects/*', target)).toBe(true)
    expect(matchProjectUri('claude:///Users/jonas/projects/*', 'claude:///Users/jonas/projects/foo')).toBe(true)
    expect(matchProjectUri('claude:///Users/jonas/*', target)).toBe(true)
    expect(matchProjectUri('claude:///Users/other/*', target)).toBe(false)
  })

  test('trailing /* matches exact prefix path too', () => {
    expect(matchProjectUri('claude:///Users/jonas/projects/remote-claude/*', target)).toBe(true)
  })

  test('trailing /* requires scheme match', () => {
    expect(matchProjectUri('codex:///Users/jonas/projects/*', target)).toBe(false)
  })

  test('trailing /* requires authority match', () => {
    expect(matchProjectUri('claude://studio/Users/jonas/projects/*', target)).toBe(false)
    expect(matchProjectUri('claude://studio/Users/jonas/projects/*', 'claude://studio/Users/jonas/projects/foo')).toBe(
      true,
    )
  })

  test('exact match', () => {
    expect(matchProjectUri(target, target)).toBe(true)
    expect(matchProjectUri(target, 'claude:///Users/jonas/projects/other')).toBe(false)
  })

  test('exact match normalizes before comparison', () => {
    expect(matchProjectUri('CLAUDE:///Users/jonas/projects/remote-claude', target)).toBe(true)
    expect(matchProjectUri('claude:///Users/jonas/projects/remote-claude/', target)).toBe(true)
  })

  test('does not partial-match without trailing /*', () => {
    expect(matchProjectUri('claude:///Users/jonas/projects', target)).toBe(false)
  })
})

describe('normalizeProjectUri', () => {
  test('lowercases scheme and upgrades empty authority to default', () => {
    expect(normalizeProjectUri('CLAUDE:///foo')).toBe('claude://default/foo')
  })

  test('removes trailing slash from path', () => {
    expect(normalizeProjectUri('claude:///Users/jonas/projects/foo/')).toBe('claude://default/Users/jonas/projects/foo')
  })

  test('keeps root path as /', () => {
    expect(normalizeProjectUri('claude:///')).toBe('claude://default/')
  })

  test('strips empty fragment', () => {
    expect(normalizeProjectUri('claude:///path#')).toBe('claude://default/path')
  })

  test('keeps non-empty fragment', () => {
    expect(normalizeProjectUri('claude:///path#conv-123')).toBe('claude://default/path#conv-123')
  })

  test('wildcard passes through', () => {
    expect(normalizeProjectUri('*')).toBe('*')
  })

  test('scheme-wildcard normalizes scheme case', () => {
    expect(normalizeProjectUri('CLAUDE:*')).toBe('claude:*')
  })

  test('collapses extra leading slashes + upgrades empty authority', () => {
    expect(normalizeProjectUri('claude:////Users/jonas/projects/foo')).toBe('claude://default/Users/jonas/projects/foo')
    expect(normalizeProjectUri('claude://///Users/foo')).toBe('claude://default/Users/foo')
  })

  test('preserves explicit non-default authority', () => {
    expect(normalizeProjectUri('claude://host/path')).toBe('claude://host/path')
    expect(normalizeProjectUri('claude://studio/Users/jonas/projects/foo')).toBe(
      'claude://studio/Users/jonas/projects/foo',
    )
  })

  test('already-canonical URI is unchanged', () => {
    expect(normalizeProjectUri('claude://default/Users/jonas/projects/foo')).toBe(
      'claude://default/Users/jonas/projects/foo',
    )
  })

  test('upgrades empty authority to default on every scheme', () => {
    // Pre-canonicalization data ('opencode:///path', 'codex:///path') is
    // upgraded to the canonical sentinel form -- the authority slot IS the
    // sentinel name, regardless of scheme.
    expect(normalizeProjectUri('codex:///path')).toBe('codex://default/path')
    expect(normalizeProjectUri('open-claw:///path')).toBe('open-claw://default/path')
    expect(normalizeProjectUri('opencode:///cwd')).toBe('opencode://default/cwd')
  })

  test('is idempotent', () => {
    const uris = [
      'claude://default/Users/jonas/projects/foo',
      'claude://studio/Users/jonas/projects/foo',
      '*',
      'claude:*',
      'claude://default/path#conv-123',
      'codex:///path',
    ]
    for (const uri of uris) {
      const once = normalizeProjectUri(uri)
      const twice = normalizeProjectUri(once)
      expect(twice).toBe(once)
    }
  })

  test('preserves authority', () => {
    expect(normalizeProjectUri('claude://studio/foo')).toBe('claude://studio/foo')
  })
})

describe('extractProjectLabel', () => {
  test('returns last path segment', () => {
    expect(extractProjectLabel('claude:///Users/jonas/projects/foo')).toBe('foo')
  })

  test('works with authority', () => {
    expect(extractProjectLabel('claude://studio/Users/jonas/projects/remote-claude')).toBe('remote-claude')
  })

  test('works with non-filesystem paths', () => {
    expect(extractProjectLabel('open-claw://gateway/my-thing')).toBe('my-thing')
  })

  test('returns path for root', () => {
    expect(extractProjectLabel('claude:///')).toBe('/')
  })

  test('returns pattern for universal wildcard', () => {
    expect(extractProjectLabel('*')).toBe('*')
  })

  test('returns pattern for scheme-wildcard', () => {
    expect(extractProjectLabel('claude:*')).toBe('claude:*')
  })

  test('handles deep paths', () => {
    expect(extractProjectLabel('claude:///a/b/c/d/e')).toBe('e')
  })
})

describe('isSameProject', () => {
  test('same URI is same project', () => {
    expect(isSameProject('claude:///Users/jonas/projects/foo', 'claude:///Users/jonas/projects/foo')).toBe(true)
  })

  test('different scheme case is same project', () => {
    expect(isSameProject('CLAUDE:///Users/foo', 'claude:///Users/foo')).toBe(true)
  })

  test('trailing slash difference is same project', () => {
    expect(isSameProject('claude:///Users/foo/', 'claude:///Users/foo')).toBe(true)
  })

  test('different paths are different projects', () => {
    expect(isSameProject('claude:///Users/foo', 'claude:///Users/bar')).toBe(false)
  })

  test('different schemes are different projects', () => {
    expect(isSameProject('claude:///foo', 'codex:///foo')).toBe(false)
  })

  test('different authorities are different projects', () => {
    expect(isSameProject('claude://studio/foo', 'claude://beast/foo')).toBe(false)
  })

  test('authority vs no authority are different projects', () => {
    expect(isSameProject('claude:///foo', 'claude://studio/foo')).toBe(false)
  })

  test('empty authority equals default sentinel', () => {
    expect(isSameProject('claude:///Users/jonas/projects/foo', 'claude://default/Users/jonas/projects/foo')).toBe(true)
  })

  test('quad-slash scar equals canonical form', () => {
    expect(isSameProject('claude:////Users/jonas/projects/foo', 'claude://default/Users/jonas/projects/foo')).toBe(true)
    expect(isSameProject('claude:////Users/jonas/projects/foo', 'claude:///Users/jonas/projects/foo')).toBe(true)
  })

  test('ignores conversation fragment at project level', () => {
    expect(isSameProject('claude://default/foo#conv-1', 'claude://default/foo#conv-2')).toBe(true)
    expect(isSameProject('claude://default/foo', 'claude://default/foo#conv-2')).toBe(true)
  })
})

describe('compareProjectUri', () => {
  test('returns 0 for equivalent URIs (legacy vs canonical)', () => {
    expect(compareProjectUri('claude:///foo', 'claude://default/foo')).toBe(0)
    expect(compareProjectUri('claude:////foo', 'claude://default/foo')).toBe(0)
  })

  test('ignores conversation fragment', () => {
    expect(compareProjectUri('claude://default/foo#conv-1', 'claude://default/foo#conv-9')).toBe(0)
  })

  test('returns -1 / 1 for ordering', () => {
    const a = 'claude:///Users/jonas/projects/alpha'
    const b = 'claude:///Users/jonas/projects/beta'
    expect(compareProjectUri(a, b)).toBeLessThan(0)
    expect(compareProjectUri(b, a)).toBeGreaterThan(0)
  })

  test('suitable for Array.sort()', () => {
    const input = [
      'claude://default/Users/c',
      'claude:///Users/a',
      'claude:////Users/b', // scar
      'claude://default/Users/a#conv-old',
    ]
    const sorted = [...input].sort(compareProjectUri)
    // a (from 'claude:///Users/a' and scar-fragment) first, then b, then c.
    expect(sorted[0]).toContain('/Users/a')
    expect(sorted[sorted.length - 1]).toContain('/Users/c')
  })
})

describe('compareProjectConversationUri', () => {
  test('distinguishes different conversation fragments', () => {
    expect(compareProjectConversationUri('claude://default/foo#conv-1', 'claude://default/foo#conv-2')).not.toBe(0)
  })

  test('project URI with no fragment != session URI with fragment', () => {
    expect(compareProjectConversationUri('claude://default/foo', 'claude://default/foo#conv-2')).not.toBe(0)
  })

  test('identical session URIs compare equal', () => {
    expect(compareProjectConversationUri('claude:///foo#conv-1', 'claude://default/foo#conv-1')).toBe(0)
  })

  test('isSameProjectSession wraps the comparator', () => {
    expect(isSameProjectConversation('claude:///foo#conv-1', 'claude://default/foo#conv-1')).toBe(true)
    expect(isSameProjectConversation('claude://default/foo#conv-1', 'claude://default/foo#conv-2')).toBe(false)
  })
})

describe('DEFAULT_SENTINEL_NAME', () => {
  test('is "default"', () => {
    expect(DEFAULT_SENTINEL_NAME).toBe('default')
  })
})

// ─── Legacy profile@ URI userinfo is silently stripped ─────────────────
//
// Pre-2026-05-22 URIs carried the sentinel-profile name in the URI userinfo
// (`claude://work@default/path`). Profile is now stored as a sibling field on
// the conversation record, not in the URI. parseProjectUri silently drops the
// userinfo for read-side tolerance; validateProjectUri rejects new writes.

describe('legacy profile@ URI -- parseProjectUri silently drops userinfo', () => {
  test('drops profile, keeps authority + path', () => {
    const r = parseProjectUri('claude://work@default/Users/jonas/projects/foo')
    expect(r.scheme).toBe('claude')
    expect(r.authority).toBe('default')
    expect(r.path).toBe('/Users/jonas/projects/foo')
  })

  test('drops profile against a non-default authority', () => {
    const r = parseProjectUri('claude://alt@beast/home/jonas/projects/foo')
    expect(r.authority).toBe('beast')
    expect(r.path).toBe('/home/jonas/projects/foo')
  })

  test('drops profile alongside fragment', () => {
    const r = parseProjectUri('claude://work@beast/abs#conv_x')
    expect(r.authority).toBe('beast')
    expect(r.fragment).toBe('conv_x')
  })

  test('manual-fallback path also drops userinfo', () => {
    const r = parseProjectUri('claude://work@Mistral Dophin/path')
    expect(r.scheme).toBe('claude')
    expect(r.authority).toBe('Mistral Dophin')
    expect(r.path).toBe('/path')
  })
})

describe('legacy profile@ URI -- normalize strips userinfo to canonical', () => {
  test('keeps authority + path through normalize', () => {
    expect(normalizeProjectUri('claude://work@default/Users/jonas/projects/foo')).toBe(
      'claude://default/Users/jonas/projects/foo',
    )
  })

  test('canonicalizes profile-bearing legacy URI to no-userinfo form', () => {
    expect(normalizeProjectUri('claude://alt@beast/x/y')).toBe('claude://beast/x/y')
  })
})

describe('legacy profile@ URI -- isSameProject still works', () => {
  test('profile-bearing and profile-less URIs at the same path are equal', () => {
    expect(
      isSameProject('claude://default/Users/jonas/projects/foo', 'claude://work@default/Users/jonas/projects/foo'),
    ).toBe(true)
    expect(
      isSameProject('claude://work@default/Users/jonas/projects/foo', 'claude://alt@default/Users/jonas/projects/foo'),
    ).toBe(true)
  })
})

describe('legacy profile@ URI -- matchProjectUri is profile-blind', () => {
  test('profile-less pattern matches legacy profile-bearing URI', () => {
    expect(
      matchProjectUri('claude:///Users/jonas/projects/foo', 'claude://work@default/Users/jonas/projects/foo'),
    ).toBe(true)
  })

  test('trailing /* prefix-match works on legacy profile-bearing URI', () => {
    expect(matchProjectUri('claude:///Users/jonas/projects/*', 'claude://work@default/Users/jonas/projects/foo')).toBe(
      true,
    )
  })
})

describe('legacy profile@ URI -- validateProjectUri rejects new writes', () => {
  test('rejects URI with userinfo', () => {
    const r = validateProjectUri('claude://work@default/path')
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toContain('userinfo')
  })
})

describe('projectIdentityKey -- canonical key for settings/order lookups', () => {
  test('strips conversation fragment', () => {
    expect(projectIdentityKey('claude://default/x/y#conv_abc')).toBe('claude://default/x/y')
  })

  test('strips profile@ userinfo', () => {
    expect(projectIdentityKey('claude://work@default/x/y')).toBe('claude://default/x/y')
  })

  test('upgrades empty authority to default sentinel', () => {
    expect(projectIdentityKey('claude:///x/y')).toBe('claude://default/x/y')
  })

  test('collapses quad-slash scar', () => {
    expect(projectIdentityKey('claude:////x/y')).toBe('claude://default/x/y')
  })

  test('strips trailing slash', () => {
    expect(projectIdentityKey('claude://default/x/y/')).toBe('claude://default/x/y')
  })

  test('all transformations combine', () => {
    expect(projectIdentityKey('CLAUDE://work@default/x/y/#conv_z')).toBe('claude://default/x/y')
  })

  test('idempotent on already-canonical input', () => {
    const key = 'claude://default/Users/jonas/foo'
    expect(projectIdentityKey(key)).toBe(key)
    expect(projectIdentityKey(projectIdentityKey(key))).toBe(key)
  })

  test('passes wildcards through unchanged', () => {
    expect(projectIdentityKey('*')).toBe('*')
    expect(projectIdentityKey('claude:*')).toBe('claude:*')
  })
})

describe('daemon scheme alias', () => {
  // The Claude Code daemon is the claude backend's daemon transport, not a
  // peer backend. URIs minted by legacy daemon-host binaries used `daemon://`,
  // splitting the project bucket for the same folder. The alias collapses
  // them on read so existing rows still group with PTY / headless siblings.

  test('normalizeProjectUri rewrites daemon:// to claude://', () => {
    expect(normalizeProjectUri('daemon://default/Users/jonas/projects/foo')).toBe(
      'claude://default/Users/jonas/projects/foo',
    )
  })

  test('normalizeProjectUri rewrites daemon-scheme with non-default authority', () => {
    expect(normalizeProjectUri('daemon://studio/Users/jonas/projects/foo')).toBe(
      'claude://studio/Users/jonas/projects/foo',
    )
  })

  test('normalizeProjectUri preserves fragment when aliasing scheme', () => {
    expect(normalizeProjectUri('daemon://default/Users/jonas/projects/foo#conv_abc')).toBe(
      'claude://default/Users/jonas/projects/foo#conv_abc',
    )
  })

  test('projectIdentityKey collapses daemon:// and claude:// into the same bucket', () => {
    expect(projectIdentityKey('daemon://default/Users/jonas/projects/foo')).toBe(
      projectIdentityKey('claude://default/Users/jonas/projects/foo'),
    )
  })

  test('isSameProject treats daemon and claude URIs as the same project', () => {
    expect(
      isSameProject('daemon://default/Users/jonas/projects/foo', 'claude://default/Users/jonas/projects/foo'),
    ).toBe(true)
  })

  test('compareProjectUri returns 0 for daemon vs claude on same path', () => {
    expect(
      compareProjectUri('daemon://default/Users/jonas/projects/foo', 'claude://default/Users/jonas/projects/foo'),
    ).toBe(0)
  })

  test('matchProjectUri exact match across daemon/claude alias', () => {
    expect(matchProjectUri('claude://default/foo', 'daemon://default/foo')).toBe(true)
    expect(matchProjectUri('daemon://default/foo', 'claude://default/foo')).toBe(true)
  })

  test('matchProjectUri scheme-wildcard claude:* matches daemon://', () => {
    expect(matchProjectUri('claude:*', 'daemon://default/Users/jonas/projects/foo')).toBe(true)
  })

  test('matchProjectUri scheme-wildcard daemon:* matches claude://', () => {
    expect(matchProjectUri('daemon:*', 'claude://default/Users/jonas/projects/foo')).toBe(true)
  })

  test('matchProjectUri trailing-glob claude://default/* matches daemon://', () => {
    expect(
      matchProjectUri('claude://default/Users/jonas/projects/*', 'daemon://default/Users/jonas/projects/foo'),
    ).toBe(true)
  })

  test('non-daemon non-claude schemes are unaffected', () => {
    expect(normalizeProjectUri('opencode://default/foo')).toBe('opencode://default/foo')
    expect(isSameProject('opencode://default/foo', 'claude://default/foo')).toBe(false)
  })
})

describe('worktree path alias', () => {
  // A worktree IS the same project on a branch (see WORK MODE covenant).
  // `<repo>/.claude/worktrees/<name>` collapses to `<repo>` at the parse
  // seam so spawn-lineage grouping (and every other project-keyed surface)
  // treats a worktree-spawned conversation as belonging to its parent repo.

  test('normalizeProjectUri strips a worktree-root segment', () => {
    expect(normalizeProjectUri('claude://default/Users/jonas/projects/foo/.claude/worktrees/feature-x')).toBe(
      'claude://default/Users/jonas/projects/foo',
    )
  })

  test('normalizeProjectUri preserves trailing path after a worktree segment', () => {
    expect(
      normalizeProjectUri('claude://default/Users/jonas/projects/foo/.claude/worktrees/feature-x/src/bar.ts'),
    ).toBe('claude://default/Users/jonas/projects/foo/src/bar.ts')
  })

  test('normalizeProjectUri collapses nested worktrees in one pass', () => {
    expect(
      normalizeProjectUri(
        'claude://default/Users/jonas/projects/foo/.claude/worktrees/a/.claude/worktrees/b',
      ),
    ).toBe('claude://default/Users/jonas/projects/foo')
  })

  test('normalizeProjectUri preserves trailing path after nested worktrees', () => {
    expect(
      normalizeProjectUri(
        'claude://default/Users/jonas/projects/foo/.claude/worktrees/a/.claude/worktrees/b/src/x.ts',
      ),
    ).toBe('claude://default/Users/jonas/projects/foo/src/x.ts')
  })

  test('normalizeProjectUri preserves fragment when stripping a worktree', () => {
    expect(
      normalizeProjectUri('claude://default/Users/jonas/projects/foo/.claude/worktrees/feature-x#conv_abc'),
    ).toBe('claude://default/Users/jonas/projects/foo#conv_abc')
  })

  test('projectIdentityKey collapses worktree and parent into the same bucket', () => {
    expect(projectIdentityKey('claude://default/Users/jonas/projects/foo/.claude/worktrees/feature-x')).toBe(
      projectIdentityKey('claude://default/Users/jonas/projects/foo'),
    )
  })

  test('isSameProject treats worktree URI as the same project as its parent repo', () => {
    expect(
      isSameProject(
        'claude://default/Users/jonas/projects/foo/.claude/worktrees/feature-x',
        'claude://default/Users/jonas/projects/foo',
      ),
    ).toBe(true)
  })

  test('compareProjectUri returns 0 for worktree vs parent repo', () => {
    expect(
      compareProjectUri(
        'claude://default/Users/jonas/projects/foo/.claude/worktrees/feature-x',
        'claude://default/Users/jonas/projects/foo',
      ),
    ).toBe(0)
  })

  test('matchProjectUri exact match across worktree alias', () => {
    expect(
      matchProjectUri(
        'claude://default/Users/jonas/projects/foo',
        'claude://default/Users/jonas/projects/foo/.claude/worktrees/feature-x',
      ),
    ).toBe(true)
    expect(
      matchProjectUri(
        'claude://default/Users/jonas/projects/foo/.claude/worktrees/feature-x',
        'claude://default/Users/jonas/projects/foo',
      ),
    ).toBe(true)
  })

  test('matchProjectUri trailing-glob still matches worktree-rooted children', () => {
    expect(
      matchProjectUri(
        'claude://default/Users/jonas/projects/foo/*',
        'claude://default/Users/jonas/projects/foo/.claude/worktrees/feature-x/src/bar.ts',
      ),
    ).toBe(true)
  })

  test('worktree alias applies regardless of scheme', () => {
    expect(normalizeProjectUri('opencode://default/Users/jonas/projects/foo/.claude/worktrees/feature-x')).toBe(
      'opencode://default/Users/jonas/projects/foo',
    )
  })

  test('trailing-slash / missing-name forms are not worktree paths and pass through', () => {
    expect(normalizeProjectUri('claude://default/Users/jonas/projects/foo/.claude/worktrees/')).toBe(
      'claude://default/Users/jonas/projects/foo/.claude/worktrees',
    )
    expect(normalizeProjectUri('claude://default/Users/jonas/projects/foo/.claude/worktrees')).toBe(
      'claude://default/Users/jonas/projects/foo/.claude/worktrees',
    )
  })

  test('worktree alias composes with daemon scheme alias', () => {
    expect(
      normalizeProjectUri('daemon://default/Users/jonas/projects/foo/.claude/worktrees/feature-x'),
    ).toBe('claude://default/Users/jonas/projects/foo')
  })
})
