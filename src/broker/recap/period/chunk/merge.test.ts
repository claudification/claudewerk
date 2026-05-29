import { describe, expect, it } from 'bun:test'
import type { RecapItem, RecapMetadata } from '../../../../shared/protocol'
import { dedupItems, itemDedupKey, makeEmptyMetadata, mergeMetadata, unionStrings } from './merge'

function meta(over: Partial<RecapMetadata>): RecapMetadata {
  return { ...makeEmptyMetadata(), ...over }
}

describe('unionStrings', () => {
  it('dedups, trims, drops empties, preserves first-seen order', () => {
    expect(unionStrings(['  a ', 'b', 'a', '', '  ', 'c', 'b'])).toEqual(['a', 'b', 'c'])
  })
  it('is case-sensitive (keeps canonical casing distinct)', () => {
    expect(unionStrings(['SQLite', 'sqlite'])).toEqual(['SQLite', 'sqlite'])
  })
})

describe('itemDedupKey', () => {
  it('normalizes title (case + punctuation + whitespace)', () => {
    expect(itemDedupKey({ title: 'Fix  the Bug!!' })).toBe(itemDedupKey({ title: 'fix the bug' }))
  })
  it('distinguishes same title with different first commit', () => {
    expect(itemDedupKey({ title: 'x', commits: ['abc1234'] })).not.toBe(
      itemDedupKey({ title: 'x', commits: ['def5678'] }),
    )
  })
  it('same title + same first commit collide', () => {
    expect(itemDedupKey({ title: 'x', commits: ['abc1234', 'zzz'] })).toBe(
      itemDedupKey({ title: 'x', commits: ['abc1234'] }),
    )
  })
})

describe('dedupItems', () => {
  it('merges duplicates: union conversations + commits, longer detail wins', () => {
    const items: RecapItem[] = [
      { title: 'Ship widget', detail: 'short', conversations: ['conv_aaa'], commits: ['abc1234'] },
      {
        title: 'ship  widget',
        detail: 'a much longer detail string',
        conversations: ['conv_bbb'],
        commits: ['abc1234', 'def5678'],
      },
    ]
    const out = dedupItems(items)
    expect(out).toHaveLength(1)
    expect(out[0].detail).toBe('a much longer detail string')
    expect(out[0].conversations).toEqual(['conv_aaa', 'conv_bbb'])
    expect(out[0].commits).toEqual(['abc1234', 'def5678'])
  })

  it('keeps items with same title but different first commit distinct', () => {
    const out = dedupItems([
      { title: 'refactor', commits: ['abc1234'] },
      { title: 'refactor', commits: ['def5678'] },
    ])
    expect(out).toHaveLength(2)
  })

  it('marks merged item inferred only when ALL duplicates are inferred', () => {
    const allInferred = dedupItems([
      { title: 't', inferred: true },
      { title: 't', inferred: true },
    ])
    expect(allInferred[0].inferred).toBe(true)
    const oneFact = dedupItems([{ title: 't', inferred: true }, { title: 't' }])
    expect(oneFact[0].inferred).toBeUndefined()
  })

  it('drops items with empty titles and preserves first-seen order', () => {
    const out = dedupItems([{ title: 'b' }, { title: '' }, { title: 'a' }, { title: 'b' }])
    expect(out.map(i => i.title)).toEqual(['b', 'a'])
  })
})

describe('mergeMetadata', () => {
  it('unions simple string lists and dedups item lists across parts', () => {
    const merged = mergeMetadata([
      meta({ keywords: ['sqlite', 'recap'], features: [{ title: 'A', commits: ['abc1234'] }] }),
      meta({ keywords: ['recap', 'ledger'], features: [{ title: 'a', commits: ['abc1234'], detail: 'more' }] }),
    ])
    expect(merged.keywords).toEqual(['sqlite', 'recap', 'ledger'])
    expect(merged.features).toHaveLength(1)
    expect(merged.features[0].detail).toBe('more')
  })

  it('keeps the first non-empty subtitle as a fallback', () => {
    const merged = mergeMetadata([meta({ subtitle: '' }), meta({ subtitle: 'the theme' }), meta({ subtitle: 'other' })])
    expect(merged.subtitle).toBe('the theme')
  })

  it('returns a fully-formed empty metadata for empty input', () => {
    const merged = mergeMetadata([])
    expect(merged).toEqual(makeEmptyMetadata())
  })
})
