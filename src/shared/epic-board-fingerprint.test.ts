/**
 * The checkpoint gate's evidence. If this reports a change that did not happen,
 * every planned run stops for nothing and the checkpoint gets clicked through;
 * if it misses one, the planner rewrites the board silently, which is the exact
 * outcome the checkpoint exists to prevent.
 */

import { describe, expect, test } from 'bun:test'
import { boardFingerprint, fingerprintDelta } from './epic-board-fingerprint'
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

  test('does NOT move when only prose changed -- rewording is expected of a planner', () => {
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
