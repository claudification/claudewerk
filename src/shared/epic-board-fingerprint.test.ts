/**
 * The checkpoint gate's evidence. If this reports a change that did not happen,
 * every planned run stops for nothing and the checkpoint gets clicked through;
 * if it misses one, the werk-planner rewrites the board silently, which is the exact
 * outcome the checkpoint exists to prevent.
 */

import { describe, expect, test } from 'bun:test'
import { boardFingerprint, describeBoardDelta, fingerprintDelta } from './epic-board-fingerprint'
import type { ProjectTaskMeta } from './project-task-types'

function card(slug: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    title: slug,
    status: 'open',
    tags: [],
    refs: [],
    created: '',
    mtime: 0,
    bodyPreview: '',
    epic: 'e1',
    ...over,
  } as ProjectTaskMeta
}

const EPIC = card('e1', { tags: ['epic'], epic: undefined })

const print = (cards: ProjectTaskMeta[]) => boardFingerprint([EPIC, ...cards], 'e1')

describe('boardFingerprint', () => {
  test('is stable across card ORDER -- the board sorts for display, not meaning', () => {
    expect(print([card('a'), card('b')])).toBe(print([card('b'), card('a')]))
  })

  test('is stable across depends_on order for the same edges', () => {
    expect(print([card('a', { dependsOn: ['x', 'y'] })])).toBe(print([card('a', { dependsOn: ['y', 'x'] })]))
  })

  test('moves when a card is ADDED', () => {
    expect(print([card('a')])).not.toBe(print([card('a'), card('b')]))
  })

  test('moves when a card is CLOSED', () => {
    expect(print([card('a')])).not.toBe(print([card('a', { status: 'done' })]))
  })

  /** The whole reason the planning pass exists: an edge with no other change. */
  test('moves when only an ORDERING EDGE is added', () => {
    expect(print([card('a'), card('b')])).not.toBe(print([card('a'), card('b', { dependsOn: ['a'] })]))
  })

  test('does NOT move when only prose changed -- rewording is expected of a werk-planner', () => {
    // Stopping the run to report a reworded title trains you to click through
    // the checkpoint, which is worse than not having one.
    expect(print([card('a', { title: 'old' })])).toBe(print([card('a', { title: 'much better title' })]))
  })

  test('an epic with no children prints empty rather than throwing', () => {
    expect(boardFingerprint([EPIC], 'e1')).toBe('')
  })

  test('an epic that is not on the board prints empty', () => {
    expect(boardFingerprint([], 'nope')).toBe('')
  })
})

describe('fingerprintDelta', () => {
  test('names what appeared and what went, for the checkpoint message', () => {
    const before = print([card('a'), card('b')])
    const after = print([card('a'), card('b', { status: 'done' }), card('c')])
    const d = fingerprintDelta(before, after)
    expect(d.added).toContain('c:open:')
    expect(d.added).toContain('b:done:')
    expect(d.removed).toContain('b:open:')
  })

  test('an unchanged board has nothing to report', () => {
    const p = print([card('a')])
    expect(fingerprintDelta(p, p)).toEqual({ added: [], removed: [] })
  })
})

/**
 * THE BETWEEN-LEGS NOTIFICATION. A leg's re-plan does NOT stop the run, so this
 * baton entry is the only account Jonas gets of a model reshaping his board while
 * he was not watching -- and `+4/-3 card states` is not an account, it is a
 * receipt for one.
 */
describe('describeBoardDelta', () => {
  /**
   * THE LINE THIS FUNCTION EXISTS FOR, and the card's own requirement: A TEST THAT
   * A STALE EDGE GETS REWRITTEN.
   *
   * Rewriting `depends_on` against the code as it NOW exists is the whole job of a
   * re-plan, and it is the one change invisible everywhere else -- no card
   * appears, none disappears, no lane moves, and the next beat simply dispatches a
   * different set. Reported as ONE card whose edges moved, not as a delete plus an
   * insert.
   */
  test('names a REWRITTEN ordering edge, in one line, with both sides', () => {
    const before = print([card('a'), card('b', { dependsOn: ['a'] })])
    const after = print([card('a'), card('b', { dependsOn: ['c'] }), card('c')])
    expect(describeBoardDelta(before, after)).toEqual([
      'b: depends_on a -> c',
      'c: NEW (open, depends on nothing)',
    ])
  })

  test('a stale edge DELETED reads as a rewrite to nothing, not as a vanished card', () => {
    const before = print([card('a'), card('b', { dependsOn: ['a'] })])
    const after = print([card('a'), card('b')])
    expect(describeBoardDelta(before, after)).toEqual(['b: depends_on a -> nothing'])
  })

  /**
   * PAIRED BY SLUG. A card whose lane moved appears in `added` AND `removed`, and
   * reporting it as a new card plus a deleted one is how a re-plan that closed
   * three cards reads like one that deleted three.
   */
  test('a closed card is ONE line about a lane, never a delete plus an insert', () => {
    const before = print([card('a')])
    const after = print([card('a', { status: 'done' })])
    expect(describeBoardDelta(before, after)).toEqual(['a: lane open -> done'])
  })

  test('a card that both moved lane and lost an edge says both', () => {
    const before = print([card('a', { dependsOn: ['z'] })])
    const after = print([card('a', { status: 'in-progress' })])
    expect(describeBoardDelta(before, after)).toEqual([
      'a: depends_on z -> nothing',
      'a: lane open -> in-progress',
    ])
  })

  test('an archived-away card is named as GONE, with the lane it left', () => {
    expect(describeBoardDelta(print([card('a'), card('b')]), print([card('a')]))).toEqual(['b: GONE (was open)'])
  })

  test('an unchanged board says nothing at all', () => {
    const p = print([card('a', { dependsOn: ['b'] }), card('b')])
    expect(describeBoardDelta(p, p)).toEqual([])
  })

  test('the very first plan, against an empty board, is all NEW rather than a diff', () => {
    expect(describeBoardDelta('', print([card('a')]))).toEqual(['a: NEW (open, depends on nothing)'])
  })
})
