/**
 * The fold itself, away from the executor. The end-to-end proof that a renamed
 * card is not dispatched twice lives in epic-executor.test.ts; these pin the
 * cases that beat cannot reach -- a rename chain, a lane contradiction, an id
 * that maps to itself.
 */

import { describe, expect, test } from 'bun:test'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { TaskStatus } from '../shared/task-statuses'
import { applyCardRenames, cardRenames, orphanedAckLine, orphanedCardIds, renameAwareAcks } from './epic-card-rename'
import type { EpicGroup } from './epic-sweep'

function card(slug: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    status: 'open' as TaskStatus,
    title: slug,
    tags: [],
    refs: [],
    created: '',
    mtime: 1,
    bodyPreview: '',
    ...over,
  }
}

function group(over: Partial<EpicGroup> = {}): EpicGroup {
  return {
    epicId: 'e1',
    project: 'claude://studio/proj',
    inFlight: [],
    inVerify: [],
    overseerAlive: false,
    liveOverseers: [],
    settled: [],
    failedLegs: [],
    unspawnable: [],
    convIds: [],
    maxGenSeen: 3,
    ...over,
  }
}

describe('cardRenames', () => {
  test('reads every old id a card carries', () => {
    const renames = cardRenames([card('new', { renamedFrom: ['old'] })])
    expect(renames.get('old')).toBe('new')
  })

  /** A card renamed twice keeps BOTH old names, and either one still resolves.
   *  Only the surviving card is on the board, so an intermediate id it does not
   *  list is a name nothing can translate. */
  test('a card renamed twice resolves from either of its old names', () => {
    const renames = cardRenames([card('c', { renamedFrom: ['a', 'b'] })])
    expect(renames.get('a')).toBe('c')
    expect(renames.get('b')).toBe('c')
  })

  test('a card naming ITSELF is dropped rather than stored as a no-op', () => {
    expect(cardRenames([card('same', { renamedFrom: ['same'] })]).size).toBe(0)
  })

  test('a board with no renames yields an empty map', () => {
    expect(cardRenames([card('a'), card('b')]).size).toBe(0)
  })
})

describe('applyCardRenames', () => {
  const renames = cardRenames([card('new', { renamedFrom: ['old'] })])

  // One card per lane: a card in two lanes at once is the contradiction case,
  // pinned on its own below.
  test('translates every card-keyed lane', () => {
    const out = applyCardRenames(
      group({ inFlight: ['old'], inVerify: ['old'], settled: ['x'], unspawnable: ['y'] }),
      cardRenames([
        card('new', { renamedFrom: ['old'] }),
        card('X', { renamedFrom: ['x'] }),
        card('Y', { renamedFrom: ['y'] }),
      ]),
    )
    expect(out.inFlight).toEqual(['new'])
    expect(out.inVerify).toEqual(['new'])
    expect(out.settled).toEqual(['X'])
    expect(out.unspawnable).toEqual(['Y'])
  })

  test('translates a failed leg, which is keyed on the card as well as the conversation', () => {
    const leg = { cardId: 'old', convId: 'conv_a', role: 'implementer' as const, gen: 3 }
    expect(applyCardRenames(group({ failedLegs: [leg] }), renames).failedLegs[0]).toMatchObject({ cardId: 'new' })
  })

  /** Two attempts under two names are still two attempts against the ceiling --
   *  dedup here would hand a permanently unspawnable card an extra life. */
  test('does NOT deduplicate failed legs -- they are per conversation, not per card', () => {
    const legs = [
      { cardId: 'old', convId: 'conv_a', role: 'verifier' as const, gen: 3 },
      { cardId: 'new', convId: 'conv_b', role: 'verifier' as const, gen: 4 },
    ]
    expect(applyCardRenames(group({ failedLegs: legs }), renames).failedLegs).toHaveLength(2)
  })

  /**
   * The lane contradiction the merge creates and nothing else can: a dead seat
   * under the old id and a live one under the new id are two cards before the
   * fold and one card after it. Live wins, for `noteCardLiveness`'s reason.
   */
  test('a card that is both settled (old seat) and in flight (new seat) reads as IN FLIGHT', () => {
    const out = applyCardRenames(group({ settled: ['old'], inFlight: ['new'] }), renames)
    expect(out.inFlight).toEqual(['new'])
    expect(out.settled).toEqual([])
  })

  test('and the same rule holds for a card the engine had given up on', () => {
    const out = applyCardRenames(group({ unspawnable: ['old'], inFlight: ['new'] }), renames)
    expect(out.unspawnable).toEqual([])
  })

  test('two seats under two names collapse to ONE entry, not two', () => {
    expect(applyCardRenames(group({ inFlight: ['old', 'new'] }), renames).inFlight).toEqual(['new'])
  })

  test('an empty rename map returns the group untouched, same object', () => {
    const g = group({ inFlight: ['t1'] })
    expect(applyCardRenames(g, new Map())).toBe(g)
  })
})

describe('renameAwareAcks', () => {
  const renames = cardRenames([card('new', { renamedFrom: ['old'] })])

  /** ADDITIVE. The old id stays because old baton entries still name it; the new
   *  one is added because `settled` has just been translated into it. */
  test('an ack written under the old id also acknowledges the new one', () => {
    expect(renameAwareAcks(['old'], renames).sort()).toEqual(['new', 'old'])
  })

  test('leaves an unrelated ack alone', () => {
    expect(renameAwareAcks(['other'], renames)).toEqual(['other'])
  })

  test('with no renames it is the identity', () => {
    expect(renameAwareAcks(['a', 'b'], new Map())).toEqual(['a', 'b'])
  })
})

describe('orphanedCardIds', () => {
  test('a live seat holding an id no card carries is reported', () => {
    expect(orphanedCardIds(group({ inFlight: ['ghost'] }), [card('t1')])).toEqual(['ghost'])
  })

  test('a RECORDED rename is not an orphan once the group has been folded', () => {
    const renames = cardRenames([card('new', { renamedFrom: ['old'] })])
    const folded = applyCardRenames(group({ inFlight: ['old'] }), renames)
    expect(orphanedCardIds(folded, [card('new', { renamedFrom: ['old'] })])).toEqual([])
  })

  /** A board read that failed comes back empty, and calling every live seat
   *  orphaned is the one way to get this check ignored wholesale. */
  test('an empty board reports nothing at all', () => {
    expect(orphanedCardIds(group({ inFlight: ['t1'] }), [])).toEqual([])
  })

  test('only LIVE seats count -- a settled card nobody has is not an orphaned ack', () => {
    expect(orphanedCardIds(group({ settled: ['gone'] }), [card('t1')])).toEqual([])
  })
})

describe('orphanedAckLine', () => {
  test('names the ids and the cause a reader can actually act on', () => {
    const line = orphanedAckLine(['ghost'])
    expect(line).toContain('ghost')
    expect(line).toContain('renamed_from')
    expect(line).toStartWith('WARN')
  })
})
