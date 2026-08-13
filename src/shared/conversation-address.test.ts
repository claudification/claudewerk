import { describe, expect, it } from 'bun:test'
import {
  formatConversationAddress,
  isWildcardPattern,
  matchesAddressPattern,
  matchesAnyPattern,
  normalizeAddressPattern,
  parseAddressPattern,
  slugifyAddressPart,
} from './conversation-address'

/** Match helper: parse + match in one call so cases read as pattern -> address. */
function hits(pattern: string, address: string): boolean {
  const parsed = parseAddressPattern(pattern)
  if (!parsed) throw new Error(`pattern did not parse: ${pattern}`)
  return matchesAddressPattern(parsed, address)
}

describe('slugifyAddressPart', () => {
  it('keeps the historical address-book rules (lowercase, hyphens, 24 cap)', () => {
    expect(slugifyAddressPart('Remote Claude')).toBe('remote-claude')
    expect(slugifyAddressPart('  --Fix: The Thing!  ')).toBe('fix-the-thing')
    expect(slugifyAddressPart('a'.repeat(40))).toBe('a'.repeat(24))
  })

  it('never returns empty -- an unslugabble name still addresses something', () => {
    expect(slugifyAddressPart('!!!')).toBe('project')
    expect(slugifyAddressPart('')).toBe('project')
  })
})

describe('parseAddressPattern', () => {
  it('treats a bare token as the WHOLE project', () => {
    expect(parseAddressPattern('remote-claude')).toEqual({ project: 'remote-claude', conversation: '*' })
  })

  it('reads both halves, splitting on the FIRST colon', () => {
    expect(parseAddressPattern('remote-claude:nightshift')).toEqual({
      project: 'remote-claude',
      conversation: 'nightshift',
    })
    // A stray second colon stays in the conversation half, where it simply
    // never matches -- same first-colon rule as resolveConversationTarget.
    expect(parseAddressPattern('a:b:c')).toBeNull()
  })

  it('folds spoken spacing into hyphens without eating the globs', () => {
    expect(parseAddressPattern('  Remote Claude : fix_* ')).toEqual({ project: 'remote-claude', conversation: 'fix-*' })
  })

  it('REFUSES a dot rather than folding regex into a fleet-wide watch', () => {
    // `.` -> `-` would turn the reflexive `.*` into `*`. Refuse instead.
    expect(parseAddressPattern('remote-claude:.*')).toBeNull()
    expect(parseAddressPattern('.*')).toBeNull()
    expect(parseAddressPattern('remote-claude:v1.2')).toBeNull()
  })

  it('reads an empty half as "any"', () => {
    expect(parseAddressPattern('remote-claude:')).toEqual({ project: 'remote-claude', conversation: '*' })
    expect(parseAddressPattern(':nightshift')).toEqual({ project: '*', conversation: 'nightshift' })
    expect(parseAddressPattern('*')).toEqual({ project: '*', conversation: '*' })
  })

  it('REFUSES junk instead of widening it', () => {
    expect(parseAddressPattern('')).toBeNull()
    expect(parseAddressPattern('   ')).toBeNull()
    expect(parseAddressPattern('remote-claude:.*')).toBeNull() // regex, not glob
    expect(parseAddressPattern('remote/claude')).toBeNull()
    expect(parseAddressPattern('what was it called again?!')).toBeNull()
  })
})

describe('normalizeAddressPattern', () => {
  it('echoes the canonical form back', () => {
    expect(normalizeAddressPattern('Remote Claude')).toBe('remote-claude:*')
    expect(normalizeAddressPattern('remote-claude:Fix Thing')).toBe('remote-claude:fix-thing')
    expect(normalizeAddressPattern('nope!')).toBeNull()
  })
})

describe('matchesAddressPattern', () => {
  const address = formatConversationAddress('remote-claude', 'nightshift-engine')

  it('matches an exact address', () => {
    expect(hits('remote-claude:nightshift-engine', address)).toBe(true)
  })

  it('matches a whole project via bare token and explicit star', () => {
    expect(hits('remote-claude', address)).toBe(true)
    expect(hits('remote-claude:*', address)).toBe(true)
  })

  it('matches a conversation glob across projects', () => {
    expect(hits('*:nightshift-*', address)).toBe(true)
    expect(hits('*:night*', address)).toBe(true)
    expect(hits('*', address)).toBe(true)
  })

  it('honours ? as exactly one character', () => {
    expect(hits('remote-claude:nightshift-engin?', address)).toBe(true)
    expect(hits('remote-claude:nightshift-engi?', address)).toBe(false)
  })

  it('does NOT match a different project or a partial without a glob', () => {
    expect(hits('other-project:*', address)).toBe(false)
    expect(hits('remote-claude:night', address)).toBe(false)
    expect(hits('remote:*', address)).toBe(false)
  })

  it('is case-insensitive on the address side too', () => {
    expect(hits('remote-claude:*', 'Remote-Claude:Nightshift-Engine')).toBe(true)
  })

  it('refuses an address with no separator', () => {
    expect(hits('*', 'nightshift-engine')).toBe(false)
  })

  it('cannot be widened by regex syntax', () => {
    const address = 'remote-claude:nightshift-engine'
    // Every regex reflex a model might reach for is refused at parse, so none
    // of them can reach the matcher and match everything.
    for (const junk of ['.*', '.+', '^remote', 'remote$', '[a-z]+', '(a|b)']) {
      expect(parseAddressPattern(junk)).toBeNull()
      expect(matchesAnyPattern([junk], address)).toBe(false)
    }
  })
})

describe('matchesAnyPattern', () => {
  const address = 'remote-claude:nightshift'

  it('matches when any pattern hits', () => {
    expect(matchesAnyPattern(['other:*', 'remote-claude:*'], address)).toBe(true)
  })

  it('ignores unparseable patterns instead of throwing', () => {
    expect(matchesAnyPattern(['///', 'remote-claude:*'], address)).toBe(true)
    expect(matchesAnyPattern(['///'], address)).toBe(false)
    expect(matchesAnyPattern([], address)).toBe(false)
  })
})

describe('isWildcardPattern', () => {
  it('flags the watch-everything pattern', () => {
    expect(isWildcardPattern({ project: '*', conversation: '*' })).toBe(true)
    expect(isWildcardPattern({ project: 'remote-claude', conversation: '*' })).toBe(false)
  })
})
