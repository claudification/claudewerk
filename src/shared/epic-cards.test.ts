import { describe, expect, it } from 'bun:test'
import {
  buildEpicIndex,
  epicBucket,
  isEpicCard,
  notStartedChildren,
  unparentedCards,
} from './epic-cards'
import type { ProjectTaskMeta } from './project-task-types'
import type { TaskStatus } from './task-statuses'

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

describe('epicBucket', () => {
  const cases: Array<[TaskStatus, string]> = [
    ['inbox', 'notStarted'],
    ['open', 'notStarted'],
    ['in-progress', 'inProgress'],
    ['in-review', 'inProgress'],
    ['done', 'done'],
    ['archived', 'dropped'],
  ]
  for (const [status, bucket] of cases) {
    it(`maps ${status} -> ${bucket}`, () => {
      expect(epicBucket(status)).toBe(bucket as ReturnType<typeof epicBucket>)
    })
  }
})

describe('isEpicCard', () => {
  it('is true for a tagged card with no children yet', () => {
    expect(isEpicCard(card('e', { tags: ['epic'] }), 0)).toBe(true)
  })

  it('is true for an untagged card that something points at', () => {
    expect(isEpicCard(card('e'), 3)).toBe(true)
  })

  it('is false for an ordinary card', () => {
    expect(isEpicCard(card('e'), 0)).toBe(false)
  })
})

describe('buildEpicIndex', () => {
  it('groups children under their declared epic', () => {
    const index = buildEpicIndex([
      card('e', { tags: ['epic'] }),
      card('a', { epic: 'e' }),
      card('b', { epic: 'e' }),
      card('loose'),
    ])
    expect(index.get('e')?.children.map(c => c.card.slug).toSorted()).toEqual(['a', 'b'])
  })

  it('counts each bucket and computes pct over non-dropped children', () => {
    const index = buildEpicIndex([
      card('e', { tags: ['epic'] }),
      card('a', { epic: 'e', status: 'done' }),
      card('b', { epic: 'e', status: 'in-review' }),
      card('c', { epic: 'e', status: 'open' }),
      card('d', { epic: 'e', status: 'archived' }),
    ])
    const r = index.get('e')
    expect(r).toMatchObject({ done: 1, inProgress: 1, notStarted: 1, dropped: 1, total: 3 })
    expect(r?.pct).toBe(33)
  })

  it('an all-archived epic reads 0 of 0, NOT 100 percent', () => {
    const index = buildEpicIndex([
      card('e', { tags: ['epic'] }),
      card('a', { epic: 'e', status: 'archived' }),
      card('b', { epic: 'e', status: 'archived' }),
    ])
    const r = index.get('e')
    expect(r?.total).toBe(0)
    expect(r?.pct).toBeNull()
  })

  it('marks an epic complete only when nothing is left open or moving', () => {
    const done = buildEpicIndex([
      card('e', { tags: ['epic'] }),
      card('a', { epic: 'e', status: 'done' }),
      card('b', { epic: 'e', status: 'archived' }),
    ])
    expect(done.get('e')?.complete).toBe(true)

    const notDone = buildEpicIndex([
      card('e', { tags: ['epic'] }),
      card('a', { epic: 'e', status: 'done' }),
      card('b', { epic: 'e', status: 'in-progress' }),
    ])
    expect(notDone.get('e')?.complete).toBe(false)
  })

  it('an epic with no children is never complete', () => {
    const index = buildEpicIndex([card('e', { tags: ['epic'] })])
    expect(index.get('e')).toMatchObject({ complete: false, total: 0, pct: null })
  })

  it('keeps a childless tagged epic in the index', () => {
    const index = buildEpicIndex([card('e', { tags: ['epic'] }), card('other')])
    expect(index.has('e')).toBe(true)
    expect(index.has('other')).toBe(false)
  })

  it('survives a child pointing at an epic the board does not have', () => {
    const index = buildEpicIndex([card('orphan', { epic: 'ghost' })])
    const r = index.get('ghost')
    expect(r?.card).toBeNull()
    expect(r?.children).toHaveLength(1)
  })

  it('reports waitingOn for depends_on targets that are not done', () => {
    const index = buildEpicIndex([
      card('e', { tags: ['epic'] }),
      card('a', { epic: 'e', status: 'done' }),
      card('b', { epic: 'e', dependsOn: ['a', 'c'] }),
      card('c', { epic: 'e', status: 'open' }),
    ])
    const b = index.get('e')?.children.find(x => x.card.slug === 'b')
    expect(b?.waitingOn).toEqual(['c'])
  })

  it('treats a child with all deps done as ready', () => {
    const index = buildEpicIndex([
      card('e', { tags: ['epic'] }),
      card('a', { epic: 'e', status: 'done' }),
      card('b', { epic: 'e', dependsOn: ['a'] }),
    ])
    const b = index.get('e')?.children.find(x => x.card.slug === 'b')
    expect(b?.waitingOn).toEqual([])
  })

  it('orders children not-started, in-progress, done, dropped', () => {
    const index = buildEpicIndex([
      card('e', { tags: ['epic'] }),
      card('d', { epic: 'e', status: 'archived' }),
      card('c', { epic: 'e', status: 'done' }),
      card('b', { epic: 'e', status: 'in-progress' }),
      card('a', { epic: 'e', status: 'open' }),
    ])
    expect(index.get('e')?.children.map(c => c.card.slug)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is empty for a board with no epics at all', () => {
    expect(buildEpicIndex([card('a'), card('b')]).size).toBe(0)
  })
})

describe('unparentedCards', () => {
  it('excludes both children and the epics themselves', () => {
    const cards = [card('e', { tags: ['epic'] }), card('a', { epic: 'e' }), card('loose')]
    const index = buildEpicIndex(cards)
    expect(unparentedCards(cards, index).map(c => c.slug)).toEqual(['loose'])
  })
})

describe('notStartedChildren', () => {
  it('returns only inbox and open children -- what a launch pre-selects', () => {
    const index = buildEpicIndex([
      card('e', { tags: ['epic'] }),
      card('a', { epic: 'e', status: 'open' }),
      card('b', { epic: 'e', status: 'inbox' }),
      card('c', { epic: 'e', status: 'in-progress' }),
      card('d', { epic: 'e', status: 'done' }),
    ])
    const rollup = index.get('e')
    expect(rollup && notStartedChildren(rollup).map(c => c.slug).toSorted()).toEqual(['a', 'b'])
  })
})
