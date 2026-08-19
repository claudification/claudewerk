/**
 * @vitest-environment node
 */
import { buildEpicIndex } from '@shared/epic-cards'
import type { ProjectTaskMeta } from '@shared/project-task-types'
import { describe, expect, it } from 'vitest'
import { groupCards, tagFrequencyRank, UNGROUPED_KEY } from './board-grouping'

function card(slug: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    status: 'open',
    title: slug,
    tags: [],
    refs: [],
    created: '2026-08-14T00:00:00.000Z',
    mtime: 0,
    bodyPreview: '',
    ...over,
  }
}

const EMPTY_INDEX = new Map()

describe('groupCards -- none', () => {
  it('returns one group holding everything', () => {
    const cards = [card('a'), card('b')]
    const groups = groupCards(cards, 'none', EMPTY_INDEX, new Map())
    expect(groups).toHaveLength(1)
    expect(groups[0].cards).toHaveLength(2)
    expect(groups[0].key).toBe(UNGROUPED_KEY)
  })
})

describe('groupCards -- epic', () => {
  const cards = [
    card('e', { tags: ['epic'], title: 'The Epic' }),
    card('kid1', { epic: 'e' }),
    card('kid2', { epic: 'e' }),
    card('loose'),
  ]
  const index = buildEpicIndex(cards)

  it('puts an epic card at the head of its OWN group, not in the leftovers', () => {
    const groups = groupCards(cards, 'epic', index, new Map())
    const epicGroup = groups.find(g => g.key === 'e')
    expect(epicGroup?.cards.map(c => c.slug)).toEqual(['e', 'kid1', 'kid2'])
  })

  it('labels the group with the epic card title and carries its epicId', () => {
    const groups = groupCards(cards, 'epic', index, new Map())
    const epicGroup = groups.find(g => g.key === 'e')
    expect(epicGroup?.label).toBe('The Epic')
    expect(epicGroup?.epicId).toBe('e')
  })

  it('sinks the leftovers group to last even when it is the biggest', () => {
    const many = [card('e', { tags: ['epic'] }), card('kid', { epic: 'e' }), ...[1, 2, 3, 4].map(n => card(`l${n}`))]
    const groups = groupCards(many, 'epic', buildEpicIndex(many), new Map())
    expect(groups.at(-1)?.key).toBe(UNGROUPED_KEY)
    expect(groups.at(-1)?.cards).toHaveLength(4)
  })

  it('names the leftovers "no epic" -- what is missing, not what is wrong', () => {
    const groups = groupCards(cards, 'epic', index, new Map())
    expect(groups.at(-1)?.label).toBe('no epic')
  })

  it('orders epics by outstanding work, not by size', () => {
    const cards2 = [
      card('big', { tags: ['epic'] }),
      ...[1, 2, 3].map(n => card(`b${n}`, { epic: 'big', status: 'done' })),
      card('small', { tags: ['epic'] }),
      card('s1', { epic: 'small', status: 'open' }),
    ]
    const groups = groupCards(cards2, 'epic', buildEpicIndex(cards2), new Map())
    expect(groups[0].key).toBe('small')
  })
})

describe('groupCards -- tag', () => {
  it('groups on the card tag that is most common board-wide, not the first written', () => {
    const cards = [
      card('a', { tags: ['rare', 'common'] }),
      card('b', { tags: ['common'] }),
      card('c', { tags: ['common'] }),
    ]
    const groups = groupCards(cards, 'tag', EMPTY_INDEX, tagFrequencyRank(cards))
    expect(groups[0].key).toBe('common')
    expect(groups[0].cards).toHaveLength(3)
  })

  it('sends untagged cards to the leftovers', () => {
    const cards = [card('a', { tags: ['x'] }), card('b')]
    const groups = groupCards(cards, 'tag', EMPTY_INDEX, tagFrequencyRank(cards))
    expect(groups.at(-1)?.label).toBe('no tags')
  })
})

describe('groupCards -- priority', () => {
  it('orders high, medium, low, then unset', () => {
    const cards = [
      card('l', { priority: 'low' }),
      card('n'),
      card('h', { priority: 'high' }),
      card('m', { priority: 'medium' }),
    ]
    const groups = groupCards(cards, 'priority', EMPTY_INDEX, new Map())
    expect(groups.map(g => g.key)).toEqual(['high', 'medium', 'low', UNGROUPED_KEY])
  })
})

describe('groupCards -- invariants', () => {
  it('never loses or duplicates a card, whatever the grouping', () => {
    const cards = [
      card('e', { tags: ['epic'] }),
      card('kid', { epic: 'e', tags: ['x'], priority: 'high' }),
      card('loose', { tags: ['y'] }),
      card('bare'),
    ]
    const index = buildEpicIndex(cards)
    const rank = tagFrequencyRank(cards)
    for (const by of ['none', 'epic', 'tag', 'priority'] as const) {
      const flat = groupCards(cards, by, index, rank).flatMap(g => g.cards.map(c => c.slug))
      expect(flat.toSorted()).toEqual(['bare', 'e', 'kid', 'loose'])
    }
  })
})
