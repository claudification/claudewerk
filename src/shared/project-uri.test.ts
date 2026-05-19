import { describe, expect, test } from 'bun:test'
import {
  buildProjectUri,
  compareProjectConversationUri,
  compareProjectUri,
  cwdToProjectUri,
  DEFAULT_SENTINEL_NAME,
  extractProjectLabel,
  getProfileFromUri,
  isSameProject,
  isSameProjectConversation,
  matchProjectUri,
  normalizeProjectUri,
  parseProjectUri,
  stripProfile,
  tryParseProjectUri,
  validateProjectUri,
  withProfile,
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

// ─── Sentinel-profile URI support (sentinel-profiles plan Phase 1) ─────────
//
// The URI userinfo slot (`work@default`) names the sentinel profile that
// hosts the conversation. Profile is preserved by parse / build / normalize
// (revive needs to pin the right CLAUDE_CONFIG_DIR), but identity comparison
// strips it: two conversations in the same dir under different profiles are
// the same project. See `.claude/docs/plan-sentinel-profiles.md`.

describe('sentinel profile -- parse', () => {
  test('parses profile from URI userinfo', () => {
    const r = parseProjectUri('claude://work@default/Users/jonas/projects/foo')
    expect(r.scheme).toBe('claude')
    expect(r.profile).toBe('work')
    expect(r.authority).toBe('default')
    expect(r.path).toBe('/Users/jonas/projects/foo')
  })

  test('parses profile against a non-default sentinel', () => {
    const r = parseProjectUri('claude://alt@beast/home/jonas/projects/foo')
    expect(r.profile).toBe('alt')
    expect(r.authority).toBe('beast')
  })

  test('parses profile alongside fragment', () => {
    const r = parseProjectUri('claude://work@beast/abs#conv_x')
    expect(r.profile).toBe('work')
    expect(r.authority).toBe('beast')
    expect(r.fragment).toBe('conv_x')
  })

  test('absent profile leaves field undefined', () => {
    const r = parseProjectUri('claude://default/Users/jonas/projects/foo')
    expect(r.profile).toBeUndefined()
  })

  test('decodes profile from URL.username (percent-decoded)', () => {
    // WHATWG decodes url.username before exposing it; profile names are
    // expected to be `[a-z0-9-]{1,63}` per validateProjectUri.
    const r = parseProjectUri('claude://work@DEFAULT/path')
    expect(r.profile).toBe('work')
    // Non-special-scheme hostnames are preserved as-is by WHATWG; that's
    // existing behavior, unrelated to the profile slot.
    expect(r.authority).toBe('DEFAULT')
  })

  test('manual-fallback path also picks up profile on malformed authority', () => {
    // WHATWG rejects spaces in authority and we fall back to a tolerant
    // split. The fallback should still recognize a leading `profile@` so
    // future writes can round-trip safely.
    const r = parseProjectUri('claude://work@Mistral Dophin/path')
    expect(r.scheme).toBe('claude')
    expect(r.profile).toBe('work')
    expect(r.authority).toBe('Mistral Dophin')
    expect(r.path).toBe('/path')
  })

  test('manual-fallback path leaves out-of-shape userinfo attached', () => {
    // If the userinfo doesn't match the profile shape, the fallback path
    // doesn't smuggle it into `profile` -- it stays part of the authority.
    const r = parseProjectUri('chat://not a profile@Mistral Dophin/path')
    expect(r.profile).toBeUndefined()
    expect(r.authority).toBe('not a profile@Mistral Dophin')
  })
})

describe('sentinel profile -- build', () => {
  test('emits profile@authority when profile is set', () => {
    const out = buildProjectUri({
      scheme: 'claude',
      profile: 'work',
      authority: 'default',
      path: '/Users/jonas/projects/foo',
    })
    expect(out).toBe('claude://work@default/Users/jonas/projects/foo')
  })

  test('omits userinfo when profile is absent', () => {
    const out = buildProjectUri({ scheme: 'claude', authority: 'default', path: '/path' })
    expect(out).toBe('claude://default/path')
  })

  test('emits profile alongside fragment', () => {
    const out = buildProjectUri({
      scheme: 'claude',
      profile: 'work',
      authority: 'beast',
      path: '/abs',
      fragment: 'conv_x',
    })
    expect(out).toBe('claude://work@beast/abs#conv_x')
  })

  test('default authority + profile fills in the default sentinel', () => {
    const out = buildProjectUri({ scheme: 'claude', profile: 'work', path: '/path' })
    expect(out).toBe(`claude://work@${DEFAULT_SENTINEL_NAME}/path`)
  })
})

describe('sentinel profile -- round-trip', () => {
  test('parse -> build -> parse preserves profile', () => {
    const cases: Array<{
      uri: string
      profile: string | undefined
      authority: string | undefined
      path: string
      fragment: string | undefined
    }> = [
      {
        uri: 'claude://work@default/Users/jonas/projects/foo',
        profile: 'work',
        authority: 'default',
        path: '/Users/jonas/projects/foo',
        fragment: undefined,
      },
      {
        uri: 'claude://alt@beast/home/jonas/projects/bar',
        profile: 'alt',
        authority: 'beast',
        path: '/home/jonas/projects/bar',
        fragment: undefined,
      },
      {
        uri: 'claude://work@default/path#conv_x',
        profile: 'work',
        authority: 'default',
        path: '/path',
        fragment: 'conv_x',
      },
    ]
    for (const { uri, profile, authority, path, fragment } of cases) {
      const reparsed = parseProjectUri(buildProjectUri(parseProjectUri(uri)))
      expect({
        profile: reparsed.profile,
        authority: reparsed.authority,
        path: reparsed.path,
        fragment: reparsed.fragment,
      }).toEqual({ profile, authority, path, fragment })
    }
  })

  test('parse -> build -> normalize is idempotent with profile', () => {
    const uri = 'claude://work@default/Users/jonas/projects/foo'
    const once = normalizeProjectUri(uri)
    const twice = normalizeProjectUri(once)
    expect(once).toBe('claude://work@default/Users/jonas/projects/foo')
    expect(twice).toBe(once)
  })
})

describe('sentinel profile -- normalize preserves profile', () => {
  test('keeps profile through normalize', () => {
    expect(normalizeProjectUri('claude://work@default/Users/jonas/projects/foo')).toBe(
      'claude://work@default/Users/jonas/projects/foo',
    )
  })

  test('keeps profile through trailing-slash stripping', () => {
    expect(normalizeProjectUri('claude://work@default/Users/jonas/projects/foo/')).toBe(
      'claude://work@default/Users/jonas/projects/foo',
    )
  })

  test('upgrades empty authority to default while preserving profile', () => {
    // Synthetic, but the building blocks should compose: a profile against
    // an empty-authority URI is a thing the manual-fallback path can produce
    // if upstream code ever mints one. Normalize fills in `default`.
    expect(normalizeProjectUri('claude://work@/path')).toBe('claude://work@default/path')
  })
})

describe('sentinel profile -- compareProjectUri ignores profile', () => {
  test('same project, different profile == same project', () => {
    expect(
      compareProjectUri('claude://default/Users/jonas/projects/foo', 'claude://work@default/Users/jonas/projects/foo'),
    ).toBe(0)
    expect(
      compareProjectUri(
        'claude://work@default/Users/jonas/projects/foo',
        'claude://alt@default/Users/jonas/projects/foo',
      ),
    ).toBe(0)
  })

  test('legacy triple-slash matches profile-less and profile-bearing', () => {
    // Documented in the plan: legacy `claude:///path` matches BOTH
    // `claude://default/path` AND `claude://work@default/path`.
    expect(compareProjectUri('claude:///Users/jonas/projects/foo', 'claude://default/Users/jonas/projects/foo')).toBe(0)
    expect(
      compareProjectUri('claude:///Users/jonas/projects/foo', 'claude://work@default/Users/jonas/projects/foo'),
    ).toBe(0)
  })

  test('different paths still differ regardless of profile', () => {
    expect(
      compareProjectUri(
        'claude://work@default/Users/jonas/projects/foo',
        'claude://work@default/Users/jonas/projects/bar',
      ),
    ).not.toBe(0)
  })

  test('isSameProject agrees with compareProjectUri', () => {
    expect(isSameProject('claude:///Users/jonas/projects/foo', 'claude://work@default/Users/jonas/projects/foo')).toBe(
      true,
    )
    expect(
      isSameProject('claude://alt@default/Users/jonas/projects/foo', 'claude://work@default/Users/jonas/projects/foo'),
    ).toBe(true)
  })
})

describe('sentinel profile -- compareProjectConversationUri ignores profile', () => {
  test('same conversation under different profiles compares equal', () => {
    expect(compareProjectConversationUri('claude://default/foo#conv_x', 'claude://work@default/foo#conv_x')).toBe(0)
  })

  test('different conversation fragments still differ even when profile matches', () => {
    expect(
      compareProjectConversationUri('claude://work@default/foo#conv_x', 'claude://work@default/foo#conv_y'),
    ).not.toBe(0)
  })

  test('isSameProjectConversation agrees', () => {
    expect(isSameProjectConversation('claude://default/foo#conv_x', 'claude://work@default/foo#conv_x')).toBe(true)
  })
})

describe('sentinel profile -- matchProjectUri ignores profile', () => {
  test('profile-less pattern matches profile-bearing URI', () => {
    expect(
      matchProjectUri('claude:///Users/jonas/projects/foo', 'claude://work@default/Users/jonas/projects/foo'),
    ).toBe(true)
    expect(
      matchProjectUri('claude://default/Users/jonas/projects/foo', 'claude://work@default/Users/jonas/projects/foo'),
    ).toBe(true)
  })

  test('profile-bearing pattern matches profile-less URI', () => {
    expect(
      matchProjectUri('claude://work@default/Users/jonas/projects/foo', 'claude:///Users/jonas/projects/foo'),
    ).toBe(true)
    expect(
      matchProjectUri('claude://work@default/Users/jonas/projects/foo', 'claude://default/Users/jonas/projects/foo'),
    ).toBe(true)
  })

  test('different profiles still match (profile-agnostic)', () => {
    expect(
      matchProjectUri(
        'claude://alt@default/Users/jonas/projects/foo',
        'claude://work@default/Users/jonas/projects/foo',
      ),
    ).toBe(true)
  })

  test('trailing /* prefix-match is profile-agnostic', () => {
    expect(matchProjectUri('claude:///Users/jonas/projects/*', 'claude://work@default/Users/jonas/projects/foo')).toBe(
      true,
    )
    expect(matchProjectUri('claude://work@default/Users/jonas/projects/*', 'claude:///Users/jonas/projects/foo')).toBe(
      true,
    )
  })

  test('scheme/path still gate matching even when profile differs', () => {
    expect(
      matchProjectUri('claude://work@default/Users/jonas/projects/foo', 'codex://default/Users/jonas/projects/foo'),
    ).toBe(false)
    expect(matchProjectUri('claude://work@default/Users/foo', 'claude://alt@default/Users/bar')).toBe(false)
  })
})

describe('sentinel profile -- cwdToProjectUri accepts profile', () => {
  test('emits profile-bearing URI when profile is supplied', () => {
    expect(cwdToProjectUri('/Users/jonas/projects/foo', 'claude', 'beast', 'work')).toBe(
      'claude://work@beast/Users/jonas/projects/foo',
    )
  })

  test('defaults authority to DEFAULT_SENTINEL_NAME with profile', () => {
    expect(cwdToProjectUri('/Users/jonas/projects/foo', 'claude', undefined, 'work')).toBe(
      `claude://work@${DEFAULT_SENTINEL_NAME}/Users/jonas/projects/foo`,
    )
  })

  test('omits profile slot when profile is undefined (legacy behavior)', () => {
    expect(cwdToProjectUri('/Users/jonas/projects/foo')).toBe('claude://default/Users/jonas/projects/foo')
  })
})

describe('sentinel profile -- validateProjectUri', () => {
  test('accepts profile-shaped username', () => {
    expect(validateProjectUri('claude://work@default/Users/jonas/projects/foo').valid).toBe(true)
    expect(validateProjectUri('claude://work-2@default/path').valid).toBe(true)
    expect(validateProjectUri('claude://alt@beast/path').valid).toBe(true)
  })

  test('rejects profile with uppercase / special chars', () => {
    const r = validateProjectUri('claude://Work@default/path')
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toContain('invalid profile')
  })

  test('rejects profile with underscore (not in [a-z0-9-])', () => {
    const r = validateProjectUri('claude://work_profile@default/path')
    expect(r.valid).toBe(false)
  })

  test('rejects userinfo with password', () => {
    const r = validateProjectUri('claude://work:secret@default/path')
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toContain('password')
  })

  test('still rejects port', () => {
    expect(validateProjectUri('claude://work@default:9999/path').valid).toBe(false)
  })

  test('still rejects query string', () => {
    expect(validateProjectUri('claude://work@default/path?q=1').valid).toBe(false)
  })

  test('rejects profile that is too long', () => {
    const tooLong = 'a'.repeat(64)
    expect(validateProjectUri(`claude://${tooLong}@default/path`).valid).toBe(false)
  })
})

describe('sentinel profile -- stripProfile', () => {
  test('strips userinfo, leaves the rest untouched', () => {
    expect(stripProfile('claude://work@default/Users/jonas/projects/foo')).toBe(
      'claude://default/Users/jonas/projects/foo',
    )
  })

  test('keeps fragment intact', () => {
    expect(stripProfile('claude://work@default/path#conv_x')).toBe('claude://default/path#conv_x')
  })

  test('no-op when there is no userinfo', () => {
    expect(stripProfile('claude://default/Users/jonas/projects/foo')).toBe('claude://default/Users/jonas/projects/foo')
    expect(stripProfile('claude:///path')).toBe('claude:///path')
    expect(stripProfile('claude:////scar/path')).toBe('claude:////scar/path')
  })

  test('safe on wildcards', () => {
    expect(stripProfile('*')).toBe('*')
    expect(stripProfile('claude:*')).toBe('claude:*')
  })

  test('does not strip an @ in the path', () => {
    // `@` past the first '/' lives in the path, not userinfo.
    expect(stripProfile('claude://default/Users/foo@example/proj')).toBe('claude://default/Users/foo@example/proj')
  })

  test('does not strip an @ in the fragment', () => {
    expect(stripProfile('claude://default/path#foo@bar')).toBe('claude://default/path#foo@bar')
  })

  test('handles non-claude schemes the same way', () => {
    expect(stripProfile('codex://work@beast/path')).toBe('codex://beast/path')
    expect(stripProfile('opencode://alt@default/path')).toBe('opencode://default/path')
  })
})

describe('withProfile', () => {
  test('sets profile on profile-less URI', () => {
    expect(withProfile('claude://default/path', 'work')).toBe('claude://work@default/path')
  })

  test('replaces existing profile', () => {
    expect(withProfile('claude://alt@default/path', 'work')).toBe('claude://work@default/path')
  })

  test('strips profile when given undefined', () => {
    expect(withProfile('claude://work@default/path', undefined)).toBe('claude://default/path')
    expect(withProfile('claude://default/path', undefined)).toBe('claude://default/path')
  })

  test('preserves path and fragment', () => {
    expect(withProfile('claude://default/Users/jonas/projects/foo#conv_x', 'work')).toBe(
      'claude://work@default/Users/jonas/projects/foo#conv_x',
    )
  })

  test('safe on wildcards / malformed URIs', () => {
    // No scheme://: pass-through after stripping (still no userinfo to strip).
    expect(withProfile('*', 'work')).toBe('*')
    expect(withProfile('not-a-uri', 'work')).toBe('not-a-uri')
  })

  test('works across schemes', () => {
    expect(withProfile('codex://beast/path', 'work')).toBe('codex://work@beast/path')
    expect(withProfile('opencode://default/path', 'alt')).toBe('opencode://alt@default/path')
  })
})

describe('getProfileFromUri', () => {
  test('returns the profile when present', () => {
    expect(getProfileFromUri('claude://work@default/path')).toBe('work')
    expect(getProfileFromUri('claude://alt@beast/path#conv_x')).toBe('alt')
  })

  test('returns undefined for profile-less URIs', () => {
    expect(getProfileFromUri('claude://default/path')).toBeUndefined()
    expect(getProfileFromUri('claude:///path')).toBeUndefined()
  })

  test('safe on malformed input', () => {
    expect(getProfileFromUri('not-a-uri')).toBeUndefined()
    // `*` parses as wildcard with no profile.
    expect(getProfileFromUri('*')).toBeUndefined()
  })
})
