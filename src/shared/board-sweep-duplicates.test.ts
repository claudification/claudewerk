import { describe, expect, test } from 'bun:test'
import {
  jaccard,
  MAX_DUPLICATE_PAIRS,
  pairsAsDuplicateCandidate,
  shortlistDuplicates,
  TAG_NEAR,
  TITLE_FLOOR,
  TITLE_NEAR,
} from './board-sweep-duplicates'
import type { ProjectTaskMeta } from './project-task-types'
import type { TaskStatus } from './task-statuses'

function card(slug: string, title: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    status: 'open' as TaskStatus,
    title,
    tags: [],
    refs: [],
    created: '2026-08-01T00:00:00Z',
    mtime: 0,
    bodyPreview: `preview of ${slug}`,
    ...over,
  }
}

describe('jaccard', () => {
  test('an empty set scores 0 against anything -- "neither has tags" is not evidence', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0)
    expect(jaccard(new Set(), new Set())).toBe(0)
  })

  test('identical sets score 1, disjoint score 0', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0)
  })

  test('half-overlap', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3)
  })
})

describe('the pair rule', () => {
  test('near-identical titles pair on their own', () => {
    expect(pairsAsDuplicateCandidate(TITLE_NEAR, 0)).toBe(true)
  })

  test('tag overlap alone never pairs -- half this board is tagged the same', () => {
    expect(pairsAsDuplicateCandidate(TITLE_FLOOR - 0.01, 1)).toBe(false)
  })

  test('tags rescue a merely-related title', () => {
    expect(pairsAsDuplicateCandidate(TITLE_FLOOR, TAG_NEAR)).toBe(true)
    expect(pairsAsDuplicateCandidate(TITLE_FLOOR, TAG_NEAR - 0.01)).toBe(false)
  })
})

describe('shortlisting', () => {
  test('the same card filed twice with one word different is a pair', () => {
    const { pairs } = shortlistDuplicates([
      card('a', 'the board scavenger sweep, on the scanner contract'),
      card('b', 'the board scavenger sweep, on the scanner covenant'),
    ])
    expect(pairs).toHaveLength(1)
    expect(pairs[0].a).toBe('a')
    expect(pairs[0].b).toBe('b')
  })

  test('unrelated titles are not a pair', () => {
    const { pairs } = shortlistDuplicates([
      card('a', 'wire the deepgram socket'),
      card('b', 'archive cold inbox cards'),
    ])
    expect(pairs).toEqual([])
  })

  test('two FINISHED cards never pair -- history nobody can act on', () => {
    const title = 'the identical title'
    const { pairs } = shortlistDuplicates([
      card('a', title, { status: 'done' }),
      card('b', title, { status: 'archived' }),
    ])
    expect(pairs).toEqual([])
  })

  test('a live card against a finished one DOES pair -- that one means "you are about to rebuild it"', () => {
    const title = 'the identical title'
    const { pairs } = shortlistDuplicates([card('a', title, { status: 'done' }), card('b', title, { status: 'open' })])
    expect(pairs).toHaveLength(1)
  })

  test('the pair id is sorted, so one pair has one identity whatever the read order', () => {
    const title = 'the identical title'
    const forwards = shortlistDuplicates([card('zzz', title), card('aaa', title)]).pairs[0]
    const backwards = shortlistDuplicates([card('aaa', title), card('zzz', title)]).pairs[0]
    expect(forwards.a).toBe('aaa')
    expect(forwards.b).toBe('zzz')
    expect(backwards).toEqual(forwards)
  })

  test('the candidate carries the previews, so the caller never re-reads a card', () => {
    const title = 'the identical title'
    const { pairs } = shortlistDuplicates([card('a', title), card('b', title)])
    expect(pairs[0].aPreview).toBe('preview of a')
    expect(pairs[0].bPreview).toBe('preview of b')
  })

  test('the cap splits rather than truncates -- overflow is returned, not dropped', () => {
    const title = 'the identical title'
    const cards = Array.from({ length: 12 }, (_, i) => card(`c${i}`, title))
    const { pairs, overflow } = shortlistDuplicates(cards, 5)
    // C(12,2) = 66 pairs, five shown, sixty-one reported as capped.
    expect(pairs).toHaveLength(5)
    expect(overflow).toHaveLength(61)
  })

  test('the default cap is the exported constant', () => {
    const title = 'the identical title'
    const cards = Array.from({ length: 12 }, (_, i) => card(`c${i}`, title))
    expect(shortlistDuplicates(cards).pairs).toHaveLength(MAX_DUPLICATE_PAIRS)
  })

  test('ties break on the pair id, so a reordered board hands the model the same shortlist', () => {
    const title = 'the identical title'
    const cards = [card('c', title), card('a', title), card('b', title)]
    const forwards = shortlistDuplicates(cards, 2).pairs
    const backwards = shortlistDuplicates([...cards].reverse(), 2).pairs
    expect(forwards.map(p => `${p.a}/${p.b}`)).toEqual(['a/b', 'a/c'])
    expect(backwards).toEqual(forwards)
  })
})
