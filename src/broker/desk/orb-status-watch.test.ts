import { beforeEach, describe, expect, it } from 'bun:test'
import {
  applyWatch,
  forgetWatcher,
  getWatchPatterns,
  hasWatchers,
  MAX_PATTERNS_PER_WATCHER,
  matchingWatchers,
  resetWatches,
  type WatcherSocket,
} from './orb-status-watch'

/** A stand-in control-panel socket. Identity is what matters here. */
const socket = (name: string): WatcherSocket => ({ send: () => {}, data: { name } })

beforeEach(() => {
  resetWatches()
})

describe('applyWatch', () => {
  it('adds patterns in canonical form', () => {
    const ws = socket('a')
    const r = applyWatch(ws, 'add', ['Remote Claude', 'other:fix-*'])
    expect(r.patterns).toEqual(['remote-claude:*', 'other:fix-*'])
    expect(r.rejected).toEqual([])
    expect(getWatchPatterns(ws)).toEqual(['remote-claude:*', 'other:fix-*'])
  })

  it('is additive and de-duplicates across calls', () => {
    const ws = socket('a')
    applyWatch(ws, 'add', ['remote-claude'])
    expect(applyWatch(ws, 'add', ['remote-claude:*', 'other']).patterns).toEqual(['remote-claude:*', 'other:*'])
  })

  it('replaces, removes and clears', () => {
    const ws = socket('a')
    applyWatch(ws, 'add', ['a', 'b', 'c'])
    expect(applyWatch(ws, 'remove', ['b']).patterns).toEqual(['a:*', 'c:*'])
    expect(applyWatch(ws, 'replace', ['z']).patterns).toEqual(['z:*'])
    expect(applyWatch(ws, 'clear').patterns).toEqual([])
    expect(getWatchPatterns(ws)).toEqual([])
  })

  it('reports junk instead of silently dropping it', () => {
    const r = applyWatch(socket('a'), 'add', ['remote-claude', 'what?!', '.*'])
    expect(r.patterns).toEqual(['remote-claude:*'])
    expect(r.rejected).toEqual(['what?!', '.*'])
  })

  it('clips at the cap and SAYS it clipped', () => {
    const many = Array.from({ length: MAX_PATTERNS_PER_WATCHER + 3 }, (_, i) => `p${i}`)
    const r = applyWatch(socket('a'), 'add', many)
    expect(r.patterns).toHaveLength(MAX_PATTERNS_PER_WATCHER)
    expect(r.clipped).toBe(true)
  })

  it('list is a pure read', () => {
    const ws = socket('a')
    applyWatch(ws, 'add', ['remote-claude'])
    expect(applyWatch(ws, 'list').patterns).toEqual(['remote-claude:*'])
    expect(getWatchPatterns(ws)).toEqual(['remote-claude:*'])
  })

  it('keeps sockets isolated from each other', () => {
    const a = socket('a')
    const b = socket('b')
    applyWatch(a, 'add', ['x'])
    applyWatch(b, 'add', ['y'])
    expect(getWatchPatterns(a)).toEqual(['x:*'])
    expect(getWatchPatterns(b)).toEqual(['y:*'])
  })
})

describe('the socket IS the lifetime', () => {
  it('forgetWatcher drops everything that socket held', () => {
    const ws = socket('a')
    applyWatch(ws, 'add', ['remote-claude'])
    expect(matchingWatchers('remote-claude:x')).toEqual([ws])

    forgetWatcher(ws)
    expect(getWatchPatterns(ws)).toEqual([])
    expect(matchingWatchers('remote-claude:x')).toEqual([])
    expect(hasWatchers()).toBe(false)
  })

  it('a RECONNECT starts from nothing -- the client must re-assert', () => {
    const before = socket('conn-1')
    applyWatch(before, 'add', ['remote-claude'])
    forgetWatcher(before) // socket closed

    // The new socket is a different object, so it inherits nothing. This is the
    // property that makes the client the single source of truth.
    const after = socket('conn-2')
    expect(getWatchPatterns(after)).toEqual([])
    expect(matchingWatchers('remote-claude:x')).toEqual([])

    applyWatch(after, 'replace', ['remote-claude'])
    expect(matchingWatchers('remote-claude:x')).toEqual([after])
  })

  it('a replayed assert CONVERGES rather than accumulating', () => {
    const ws = socket('a')
    // A flaky reconnect can replay the same list more than once against a
    // socket the broker did not actually forget; replace must be idempotent.
    applyWatch(ws, 'replace', ['a', 'b'])
    applyWatch(ws, 'replace', ['a', 'b'])
    expect(getWatchPatterns(ws)).toEqual(['a:*', 'b:*'])
  })

  it('forgetting an unknown socket is a no-op, not a throw', () => {
    expect(() => forgetWatcher(socket('never-watched'))).not.toThrow()
  })
})

describe('matchingWatchers', () => {
  it('returns every socket whose pattern hits, and only those', () => {
    const a = socket('a')
    const b = socket('b')
    const c = socket('c')
    applyWatch(a, 'add', ['remote-claude:*'])
    applyWatch(b, 'add', ['*:nightshift'])
    applyWatch(c, 'add', ['other:*'])

    expect(matchingWatchers('remote-claude:nightshift')).toEqual([a, b])
    expect(matchingWatchers('remote-claude:something')).toEqual([a])
    expect(matchingWatchers('unrelated:thing')).toEqual([])
  })

  it('returns nothing when nobody is watching', () => {
    expect(matchingWatchers('remote-claude:x')).toEqual([])
    expect(hasWatchers()).toBe(false)
  })
})
