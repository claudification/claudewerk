import { beforeEach, describe, expect, it } from 'bun:test'
import {
  applyWatch,
  getWatchPatterns,
  MAX_PATTERNS_PER_ORB,
  matchingOrbs,
  resetWatches,
  WATCH_TTL_MS,
} from './orb-status-watch'

const NOW = 1_700_000_000_000

beforeEach(() => {
  resetWatches()
})

describe('applyWatch', () => {
  it('adds patterns in canonical form and reports the expiry', () => {
    const r = applyWatch('orb-1', 'add', ['Remote Claude', 'other:fix-*'], NOW)
    expect(r.patterns).toEqual(['remote-claude:*', 'other:fix-*'])
    expect(r.rejected).toEqual([])
    expect(r.expiresAt).toBe(NOW + WATCH_TTL_MS)
  })

  it('is additive and de-duplicates across calls', () => {
    applyWatch('orb-1', 'add', ['remote-claude'], NOW)
    const r = applyWatch('orb-1', 'add', ['remote-claude:*', 'other'], NOW)
    expect(r.patterns).toEqual(['remote-claude:*', 'other:*'])
  })

  it('replaces, removes and clears', () => {
    applyWatch('orb-1', 'add', ['a', 'b', 'c'], NOW)
    expect(applyWatch('orb-1', 'remove', ['b'], NOW).patterns).toEqual(['a:*', 'c:*'])
    expect(applyWatch('orb-1', 'replace', ['z'], NOW).patterns).toEqual(['z:*'])
    expect(applyWatch('orb-1', 'clear', [], NOW).patterns).toEqual([])
    expect(getWatchPatterns('orb-1', NOW)).toEqual([])
  })

  it('reports junk instead of silently dropping it', () => {
    const r = applyWatch('orb-1', 'add', ['remote-claude', 'what?!', '.*'], NOW)
    expect(r.patterns).toEqual(['remote-claude:*'])
    expect(r.rejected).toEqual(['what?!', '.*'])
  })

  it('clips at the cap and SAYS it clipped', () => {
    const many = Array.from({ length: MAX_PATTERNS_PER_ORB + 3 }, (_, i) => `p${i}`)
    const r = applyWatch('orb-1', 'add', many, NOW)
    expect(r.patterns).toHaveLength(MAX_PATTERNS_PER_ORB)
    expect(r.clipped).toBe(true)
  })

  it('list is a pure read -- it does not extend the TTL', () => {
    applyWatch('orb-1', 'add', ['remote-claude'], NOW)
    const later = NOW + 60_000
    const r = applyWatch('orb-1', 'list', [], later)
    expect(r.patterns).toEqual(['remote-claude:*'])
    expect(r.expiresAt).toBe(NOW + WATCH_TTL_MS) // NOT later + TTL
  })

  it('keeps orbs isolated from each other', () => {
    applyWatch('orb-1', 'add', ['a'], NOW)
    applyWatch('orb-2', 'add', ['b'], NOW)
    expect(getWatchPatterns('orb-1', NOW)).toEqual(['a:*'])
    expect(getWatchPatterns('orb-2', NOW)).toEqual(['b:*'])
  })
})

describe('TTL', () => {
  it('goes quiet on its own once expired', () => {
    applyWatch('orb-1', 'add', ['remote-claude'], NOW)
    expect(matchingOrbs('remote-claude:x', NOW + WATCH_TTL_MS - 1)).toEqual(['orb-1'])
    expect(matchingOrbs('remote-claude:x', NOW + WATCH_TTL_MS)).toEqual([])
    expect(getWatchPatterns('orb-1', NOW + WATCH_TTL_MS)).toEqual([])
  })

  it('a re-stated watch refreshes the clock', () => {
    applyWatch('orb-1', 'add', ['remote-claude'], NOW)
    const halfway = NOW + WATCH_TTL_MS / 2
    applyWatch('orb-1', 'add', ['remote-claude'], halfway)
    expect(matchingOrbs('remote-claude:x', NOW + WATCH_TTL_MS + 1)).toEqual(['orb-1'])
  })
})

describe('matchingOrbs', () => {
  it('returns every orb whose pattern hits, and only those', () => {
    applyWatch('orb-1', 'add', ['remote-claude:*'], NOW)
    applyWatch('orb-2', 'add', ['*:nightshift'], NOW)
    applyWatch('orb-3', 'add', ['other:*'], NOW)

    expect(matchingOrbs('remote-claude:nightshift', NOW).sort()).toEqual(['orb-1', 'orb-2'])
    expect(matchingOrbs('remote-claude:something', NOW)).toEqual(['orb-1'])
    expect(matchingOrbs('unrelated:thing', NOW)).toEqual([])
  })

  it('maps the bare-orb key back to null (= every panel)', () => {
    applyWatch(null, 'add', ['remote-claude'], NOW)
    expect(matchingOrbs('remote-claude:x', NOW)).toEqual([null])
  })

  it('returns nothing when nobody is watching', () => {
    expect(matchingOrbs('remote-claude:x', NOW)).toEqual([])
  })
})
