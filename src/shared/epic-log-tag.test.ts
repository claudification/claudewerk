import { describe, expect, test } from 'bun:test'
import { composeBatonTag, parseBatonTag } from './epic-log-tag'

/**
 * The codec that lets one token carry two ids. Every case here is a shape that
 * either exists on disk today (bare tags, no tag) or becomes possible the moment
 * a baton stops being per-epic -- and the point of the pair is that NONE of them
 * throws or reads as nothing.
 */
describe('composeBatonTag', () => {
  test('epic + card compose into the one slot', () => {
    expect(composeBatonTag('epic-the-wall', 'wall-surface-shell')).toBe('epic-the-wall/wall-surface-shell')
  })

  test('an epic with no card still gets a token -- attribution survives without a card', () => {
    expect(composeBatonTag('epic-the-wall')).toBe('epic-the-wall/')
  })

  test('a card with no epic writes the legacy bare tag', () => {
    expect(composeBatonTag(undefined, 'wall-surface-shell')).toBe('wall-surface-shell')
  })

  test('neither means no tag at all, exactly as before', () => {
    expect(composeBatonTag()).toBeUndefined()
    expect(composeBatonTag('', '')).toBeUndefined()
  })
})

describe('parseBatonTag', () => {
  test('a composed tag splits into both ids', () => {
    expect(parseBatonTag('epic-the-wall/wall-surface-shell', 'whatever')).toEqual({
      epicId: 'epic-the-wall',
      cardId: 'wall-surface-shell',
    })
  })

  /** THE BACKWARD-COMPATIBILITY CONTRACT. 1.7 MB of batons on disk are bare. */
  test('a legacy bare tag is a card in the log its own epic', () => {
    expect(parseBatonTag('wall-surface-shell', 'epic-the-wall')).toEqual({
      epicId: 'epic-the-wall',
      cardId: 'wall-surface-shell',
    })
  })

  test('no tag at all is the log own epic and no card', () => {
    expect(parseBatonTag(undefined, 'epic-the-wall')).toEqual({ epicId: 'epic-the-wall' })
    expect(parseBatonTag('', 'epic-the-wall')).toEqual({ epicId: 'epic-the-wall' })
  })

  test('a trailing separator is an epic with no card, not a card named empty', () => {
    expect(parseBatonTag('epic-other/', 'epic-the-wall')).toEqual({ epicId: 'epic-other' })
  })

  test('a leading separator falls back to the log own epic rather than an empty one', () => {
    expect(parseBatonTag('/wall-surface-shell', 'epic-the-wall')).toEqual({
      epicId: 'epic-the-wall',
      cardId: 'wall-surface-shell',
    })
  })

  test('a separator alone degrades to the no-tag case', () => {
    expect(parseBatonTag('/', 'epic-the-wall')).toEqual({ epicId: 'epic-the-wall' })
  })

  /** FIRST separator: the epic id can never contain one, the remainder is opaque. */
  test('several separators keep everything after the first as the card', () => {
    expect(parseBatonTag('epic-x/a/b/c', 'epic-the-wall')).toEqual({ epicId: 'epic-x', cardId: 'a/b/c' })
  })
})

describe('the pair round-trips', () => {
  const cases: Array<[string | undefined, string | undefined]> = [
    ['epic-the-wall', 'wall-surface-shell'],
    ['epic-the-wall', undefined],
    [undefined, 'wall-surface-shell'],
    ['epic-x', 'a/b/c'],
  ]
  for (const [epicId, cardId] of cases) {
    test(`${epicId ?? '-'} + ${cardId ?? '-'}`, () => {
      const parsed = parseBatonTag(composeBatonTag(epicId, cardId), 'fallback-epic')
      expect(parsed.epicId).toBe(epicId ?? 'fallback-epic')
      expect(parsed.cardId).toBe(cardId as string | undefined)
    })
  }
})
