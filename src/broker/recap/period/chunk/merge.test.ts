import { describe, expect, it } from 'bun:test'
import type { RecapItem, RecapMetadata } from '../../../../shared/protocol'
import { dedupItems, itemDedupKey, makeEmptyMetadata, mergeMetadata, mergeOutcome, unionStrings } from './merge'

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

  it('dedups frustrations across parts like the other item lists', () => {
    const merged = mergeMetadata([
      meta({ frustrations: [{ title: 'page not scrollable', conversations: ['conv_aaa'] }] }),
      meta({ frustrations: [{ title: 'Page Not Scrollable', conversations: ['conv_bbb'], detail: 'twice' }] }),
    ])
    expect(merged.frustrations).toHaveLength(1)
    expect(merged.frustrations[0].detail).toBe('twice')
    expect(merged.frustrations[0].conversations).toEqual(['conv_aaa', 'conv_bbb'])
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

describe('mergeOutcome (Lessons Scavenger tech registry)', () => {
  it('returns the other when one side is undefined', () => {
    expect(mergeOutcome(undefined, 'success')).toBe('success')
    expect(mergeOutcome('failure', undefined)).toBe('failure')
    expect(mergeOutcome(undefined, undefined)).toBeUndefined()
  })
  it('keeps agreement', () => {
    expect(mergeOutcome('success', 'success')).toBe('success')
    expect(mergeOutcome('failure', 'failure')).toBe('failure')
  })
  it('collapses disagreement to mixed', () => {
    expect(mergeOutcome('success', 'failure')).toBe('mixed')
    expect(mergeOutcome('mixed', 'success')).toBe('mixed')
  })
})

describe('dedupItems: outcome reconciliation', () => {
  it('merges same-title tech items, reconciling outcome to mixed on conflict', () => {
    const merged = dedupItems([
      { title: 'redis', outcome: 'success', conversations: ['conv_a'] },
      { title: 'Redis', outcome: 'failure', conversations: ['conv_b'] },
    ])
    expect(merged.length).toBe(1)
    expect(merged[0].outcome).toBe('mixed')
    expect(merged[0].conversations).toEqual(['conv_a', 'conv_b'])
  })
  it('does not add an outcome when neither item has one', () => {
    const merged = dedupItems([{ title: 'x' }, { title: 'x' }])
    expect(merged[0].outcome).toBeUndefined()
    expect('outcome' in merged[0]).toBe(false)
  })
})
