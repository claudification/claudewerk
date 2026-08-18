import { describe, expect, test } from 'bun:test'
import { buildEpicIndex } from './epic-cards'
import { linkedCards } from './epic-linked'
import type { ProjectTaskMeta } from './project-task-types'

function card(slug: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    title: slug,
    status: 'open',
    priority: 'medium',
    tags: [],
    refs: [],
    ...over,
  } as unknown as ProjectTaskMeta
}

/** The epic card itself, plus whatever else the case needs. */
function board(...rest: ProjectTaskMeta[]): ProjectTaskMeta[] {
  return [card('e1', { tags: ['epic'] }), ...rest]
}

function linked(cards: ProjectTaskMeta[], epicId = 'e1') {
  const rollup = buildEpicIndex(cards).get(epicId)
  if (!rollup) throw new Error(`no rollup for ${epicId}`)
  return linkedCards(rollup, cards)
}

describe('the four directions', () => {
  test('1. a card naming the epic in relates_to', () => {
    const out = linked(board(card('a', { relatesTo: ['e1'] })))

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'direct', via: 'e1' })
  })

  test('1b. and in depends_on -- sequencing is a link too', () => {
    expect(linked(board(card('a', { dependsOn: ['e1'] })))[0]).toMatchObject({ kind: 'direct' })
  })

  test('2. the epic card naming the card', () => {
    const cards = [card('e1', { tags: ['epic'], relatesTo: ['a'] }), card('a')]

    expect(linked(cards)[0]).toMatchObject({ card: { slug: 'a' }, kind: 'direct' })
  })

  test('3. a card naming one of the epic children', () => {
    const out = linked(board(card('child', { epic: 'e1' }), card('a', { relatesTo: ['child'] })))

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ card: { slug: 'a' }, kind: 'family', via: 'child' })
  })

  test('4. a child naming the card', () => {
    const out = linked(board(card('child', { epic: 'e1', relatesTo: ['a'] }), card('a')))

    expect(out[0]).toMatchObject({ card: { slug: 'a' }, kind: 'family', via: 'child' })
  })
})

describe('what it must never suggest', () => {
  test('a card the epic already owns', () => {
    expect(linked(board(card('a', { epic: 'e1', relatesTo: ['e1'] })))).toEqual([])
  })

  test('the epic card itself', () => {
    expect(linked(board(card('child', { epic: 'e1', relatesTo: ['e1'] })))).toEqual([])
  })

  test.each(['done', 'archived'] as const)('a %s card -- nobody adopts finished work', status => {
    expect(linked(board(card('a', { status, relatesTo: ['e1'] })))).toEqual([])
  })

  test('an unrelated card', () => {
    expect(linked(board(card('a'), card('b', { relatesTo: ['a'] })))).toEqual([])
  })

  test('refs are ignored -- they hold file paths far more often than card ids', () => {
    expect(linked(board(card('a', { refs: ['e1', 'src/foo.ts'] })))).toEqual([])
  })
})

describe('a card owned by ANOTHER epic', () => {
  test('is still suggested, flagged with its current home', () => {
    const out = linked(board(card('other', { tags: ['epic'] }), card('a', { epic: 'other', relatesTo: ['e1'] })))

    expect(out[0]).toMatchObject({ card: { slug: 'a' }, ownedBy: 'other' })
  })

  test('sorts BELOW an unowned card -- an adopt is cheaper than a move', () => {
    const out = linked(
      board(
        card('other', { tags: ['epic'] }),
        card('taken', { epic: 'other', relatesTo: ['e1'] }),
        card('free', { relatesTo: ['e1'] }),
      ),
    )

    expect(out.map(l => l.card.slug)).toEqual(['free', 'taken'])
  })
})

describe('dedup and ordering', () => {
  test('a card linked twice appears once', () => {
    const cards = [card('e1', { tags: ['epic'], relatesTo: ['a'] }), card('a', { relatesTo: ['e1'] })]

    expect(linked(cards)).toHaveLength(1)
  })

  test('DIRECT wins over family for the same card, whichever is seen first', () => {
    const out = linked(board(card('child', { epic: 'e1', relatesTo: ['a'] }), card('a', { relatesTo: ['e1'] })))

    expect(out[0]).toMatchObject({ kind: 'direct', via: 'e1' })
  })

  test('direct links sort above family links', () => {
    const out = linked(
      board(card('child', { epic: 'e1' }), card('fam', { relatesTo: ['child'] }), card('dir', { relatesTo: ['e1'] })),
    )

    expect(out.map(l => l.card.slug)).toEqual(['dir', 'fam'])
  })

  test('a dangling id points at nothing and is skipped, not crashed on', () => {
    expect(linked(board(card('a', { relatesTo: ['ghost'] })))).toEqual([])
  })
})

describe('an epic with no card of its own', () => {
  test('still finds inbound links via its children', () => {
    const cards = [card('child', { epic: 'ghost-epic' }), card('a', { relatesTo: ['ghost-epic'] })]
    const out = linked(cards, 'ghost-epic')

    expect(out[0]).toMatchObject({ card: { slug: 'a' }, kind: 'direct' })
  })
})
