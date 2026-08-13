import { describe, expect, it } from 'bun:test'
import { linkageVerb, storageKey } from './card-linkage'
import { type CardLinkage, normalizeLinkageMeta, readLinkage, readOne } from './card-linkage-read'

describe('blocked_by is an alias, not a second key', () => {
  it('stores as depends_on', () => {
    expect(storageKey(linkageVerb('blocked_by') as never)).toBe('depends_on')
  })

  it('reads as depends_on, so it actually works instead of looking like it does', () => {
    expect(readLinkage({ blocked_by: ['a', 'b'] })).toEqual({ depends_on: ['a', 'b'] })
  })

  it('merges with a depends_on already on the card, without duplicating', () => {
    expect(readLinkage({ depends_on: ['a'], blocked_by: ['a', 'b'] })).toEqual({ depends_on: ['a', 'b'] })
  })

  it('collapses onto depends_on when written, leaving one spelling on disk', () => {
    expect(normalizeLinkageMeta({ title: 't', blocked_by: ['a'] })).toEqual({ title: 't', depends_on: ['a'] })
  })

  it('leaves everything the registry does not own alone', () => {
    const meta = { title: 't', evidence_commits: ['abc'], gate: 'x' }
    expect(normalizeLinkageMeta(meta)).toEqual(meta)
  })

  it('is a no-op when no alias is present -- same object back', () => {
    const meta = { title: 't', depends_on: ['a'] }
    expect(normalizeLinkageMeta(meta)).toBe(meta)
  })
})

describe('see_also is an alias of relates_to', () => {
  it('reads and writes as relates_to', () => {
    expect(readLinkage({ see_also: ['a'] })).toEqual({ relates_to: ['a'] })
    expect(normalizeLinkageMeta({ see_also: ['a'] })).toEqual({ relates_to: ['a'] })
  })
})

describe('arity coercion -- a scalar where a list belongs', () => {
  it('is kept, not dropped', () => {
    expect(readLinkage({ depends_on: 'lonely-card' })).toEqual({ depends_on: ['lonely-card'] })
  })

  it('drops empty entries rather than yielding an empty-string target', () => {
    expect(readLinkage({ depends_on: ['a', '', null] })).toEqual({ depends_on: ['a'] })
  })

  it('a list where one belongs takes the first, never the joined string', () => {
    const linkage = readLinkage({ epic: ['first', 'second'] })
    expect(readOne(linkage, 'epic')).toBe('first')
    expect(readOne(linkage, 'epic')).not.toContain(',')
  })

  it('an absent verb reads as undefined, not empty string', () => {
    expect(readOne({} as CardLinkage, 'epic')).toBeUndefined()
  })
})

describe('reading a card with no linkage at all', () => {
  it('yields nothing rather than a bag of empty arrays', () => {
    expect(readLinkage({ title: 't', status: 'open', tags: ['a'] })).toEqual({})
  })

  it('ignores an empty-string verb, which is how a blanked key serializes', () => {
    expect(readLinkage({ epic: '' })).toEqual({})
  })
})
