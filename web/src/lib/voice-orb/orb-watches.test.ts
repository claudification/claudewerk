import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearOrbWatches, getOrbWatches, reassertOrbWatches, recordWatchToolResult, setOrbWatches } from './orb-watches'

beforeEach(() => {
  localStorage.clear()
  setOrbWatches([])
  localStorage.clear()
})

describe('the stored list', () => {
  it('starts empty', () => {
    expect(getOrbWatches()).toEqual([])
  })

  it('round-trips through localStorage so a RELOAD does not lose it', () => {
    setOrbWatches(['remote-claude:*'])
    expect(JSON.parse(localStorage.getItem('rclaude.orbWatches') ?? '[]')).toEqual(['remote-claude:*'])
    expect(getOrbWatches()).toEqual(['remote-claude:*'])
  })

  it('clears the key entirely rather than storing an empty array', () => {
    setOrbWatches(['a:*'])
    setOrbWatches([])
    expect(localStorage.getItem('rclaude.orbWatches')).toBeNull()
    expect(getOrbWatches()).toEqual([])
  })

  it('hands out a copy, so a caller cannot mutate the stored list', () => {
    setOrbWatches(['a:*'])
    getOrbWatches().push('b:*')
    expect(getOrbWatches()).toEqual(['a:*'])
  })
})

describe('reassertOrbWatches', () => {
  it('replays the list on a fresh socket', () => {
    setOrbWatches(['remote-claude:*', 'arr:*'])
    const send = vi.fn()
    reassertOrbWatches(send)
    expect(send).toHaveBeenCalledWith({
      type: 'voice_watch_assert',
      patterns: ['remote-claude:*', 'arr:*'],
    })
  })

  it('says NOTHING when there is nothing watched', () => {
    const send = vi.fn()
    reassertOrbWatches(send)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('clearOrbWatches', () => {
  it('forgets locally and tells the broker to drop them', () => {
    setOrbWatches(['a:*'])
    const send = vi.fn()
    clearOrbWatches(send)
    expect(getOrbWatches()).toEqual([])
    expect(send).toHaveBeenCalledWith({ type: 'voice_watch_assert', patterns: [] })
  })
})

describe('recordWatchToolResult', () => {
  it('stores the SERVER result, not the request', () => {
    // The server normalized, de-duped and dropped junk; that outcome is what a
    // reconnect must replay.
    recordWatchToolResult({
      name: 'watch_conversations',
      ok: true,
      result: { watching: ['remote-claude:*'], rejected: ['huh?!'] },
    })
    expect(getOrbWatches()).toEqual(['remote-claude:*'])
  })

  it('records an empty list (a clear) too', () => {
    setOrbWatches(['a:*'])
    recordWatchToolResult({ name: 'watch_conversations', ok: true, result: { watching: [] } })
    expect(getOrbWatches()).toEqual([])
  })

  it('ignores a FAILED call -- nothing changed server-side', () => {
    setOrbWatches(['a:*'])
    recordWatchToolResult({ name: 'watch_conversations', ok: false, result: { watching: ['b:*'] } })
    expect(getOrbWatches()).toEqual(['a:*'])
  })

  it('ignores every other tool', () => {
    setOrbWatches(['a:*'])
    recordWatchToolResult({ name: 'read_transcript', ok: true, result: { watching: ['b:*'] } })
    expect(getOrbWatches()).toEqual(['a:*'])
  })

  it('ignores a malformed result instead of throwing', () => {
    setOrbWatches(['a:*'])
    for (const result of [undefined, null, {}, { watching: 'nope' }, { watching: [1, 2] }]) {
      expect(() => recordWatchToolResult({ name: 'watch_conversations', ok: true, result })).not.toThrow()
    }
    // The [1, 2] case stores an empty list (nothing was a string), which is
    // honest -- it never invents patterns.
    expect(getOrbWatches()).toEqual([])
  })
})
