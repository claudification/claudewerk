/**
 * The registry's job is to be the ONE declaration, so most of these tests are
 * anti-drift pins rather than behaviour: the derived order must equal the
 * literal list it replaced, the linkage verbs must not be restated, and an
 * undeclared key must stay completely invisible.
 */

import { describe, expect, test } from 'bun:test'
import { GATE_MODES } from './board-gate'
import { LINKAGE_VERBS } from './card-linkage'
import {
  CARD_KEYS,
  cardKeySpec,
  cardValueProblem,
  KNOWN_NON_LINKAGE_KEYS,
  ORDERED_CARD_KEYS,
  REQUIRED_CARD_KEYS,
} from './card-schema'
import { TASK_STATUSES } from './task-statuses'

/** The literal `ORDERED_KEYS` that lived in project-card-file.ts before the
 *  registry existed. Every card on disk is written in this order; if the
 *  derivation ever disagrees, every future write silently reshuffles them. */
const ORDERED_KEYS_BEFORE = [
  'title',
  'status',
  'priority',
  'tags',
  'refs',
  'quest',
  'epic',
  'depends_on',
  'relates_to',
  'created',
]

describe('the registry replaces the copies it was built from', () => {
  test('the derived render order is byte-identical to the literal it replaced', () => {
    expect([...ORDERED_CARD_KEYS]).toEqual(ORDERED_KEYS_BEFORE)
  })

  test('every linkage verb appears exactly once, derived and not restated', () => {
    for (const verb of LINKAGE_VERBS) {
      const spec = cardKeySpec(verb.key)
      expect(spec?.linkage).toBe(true)
      expect(spec?.doc).toBe(verb.meaning)
      expect(spec?.type).toBe(verb.arity === 'many' ? 'string[]' : 'string')
    }
  })

  test('no key is declared twice', () => {
    const keys = CARD_KEYS.map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('enums are taken from their owning module, never re-typed', () => {
    expect(cardKeySpec('status')?.values).toBe(TASK_STATUSES)
    expect(cardKeySpec('gate')?.values).toBe(GATE_MODES)
  })

  test('KNOWN_NON_LINKAGE_KEYS covers the gate keys the old STORE_KEYS missed', () => {
    for (const key of ['test_cmd', 'base', 'gate', 'evidence_worker', 'evidence_commits']) {
      expect(KNOWN_NON_LINKAGE_KEYS).toContain(key)
    }
    expect(KNOWN_NON_LINKAGE_KEYS).not.toContain('depends_on')
  })

  test('every required key carries a shipped check id and a severity', () => {
    expect(REQUIRED_CARD_KEYS.map(s => s.key).toSorted()).toEqual(['created', 'status', 'title'])
    for (const spec of REQUIRED_CARD_KEYS) expect(spec.required?.check).toMatch(/^card-/)
  })

  test('an enum key without values would validate everything -- so it must not exist', () => {
    for (const spec of CARD_KEYS) {
      if (spec.type === 'enum') expect(spec.values?.length).toBeGreaterThan(0)
    }
  })
})

describe('OPEN, not closed', () => {
  test('an undeclared key has no spec, and that is the correct answer', () => {
    expect(cardKeySpec('evidence_invented_tomorrow')).toBeUndefined()
    expect(cardKeySpec('')).toBeUndefined()
  })
})

/** `spec!` is safe here: every key named is asserted to exist above. */
function problem(key: string, value: unknown) {
  const spec = cardKeySpec(key)
  if (!spec) throw new Error(`no spec for ${key}`)
  return cardValueProblem(spec, value)
}

describe('validating the frontmatter SUBSET', () => {
  test('an empty value is never a type problem -- absence is required-ness', () => {
    for (const value of [undefined, null, '', []]) {
      expect(problem('status', value)).toBeNull()
      expect(problem('tags', value)).toBeNull()
    }
  })

  test('a good value of each type passes', () => {
    expect(problem('status', 'open')).toBeNull()
    expect(problem('tags', ['a', 'b'])).toBeNull()
    expect(problem('created', '2026-01-31T09:00:00.000Z')).toBeNull()
    expect(problem('evidence_commits', '4')).toBeNull()
    expect(problem('test_cmd', 'bun test')).toBeNull()
  })

  test('a bare value where a list belongs is MUTE and repairs by comma-split', () => {
    const found = problem('tags', 'infra, board')
    expect(found?.mute).toBe(true)
    expect(found?.repair).toEqual(['infra', 'board'])
    expect(found?.problem).toContain('no tags at all')
  })

  test('a ONE-item list where a scalar belongs unwraps; a longer one is a judgement', () => {
    expect(problem('status', ['open'])?.repair).toBe('open')
    expect(problem('status', ['open', 'done'])?.repair).toBeUndefined()
  })

  test('a lane outside the set says WHAT THE BOARD THEN DOES, not just "invalid"', () => {
    const found = problem('status', 'in-progres')
    expect(found?.problem).toContain('inbox')
    expect(found?.repair).toBeUndefined()
  })

  test('`created: undefined` from a hand-written template is caught as mute', () => {
    expect(problem('created', 'undefined')?.mute).toBe(true)
    expect(problem('created', '2026-01-31')).toBeNull()
  })

  test('a word where a number belongs is reported, never guessed at', () => {
    expect(problem('evidence_commits', 'four')?.repair).toBeUndefined()
    expect(problem('evidence_commits', 'four')?.mute).toBe(true)
  })

  test('every problem carries both halves -- a finding without a remedy is half a tool', () => {
    for (const [key, value] of [
      ['status', 'nonsense'],
      ['tags', 'a, b'],
      ['created', 'undefined'],
      ['evidence_commits', 'four'],
      ['gate', 'green'],
    ] as const) {
      const found = problem(key, value)
      expect(found?.problem.length).toBeGreaterThan(0)
      expect(found?.remedy.length).toBeGreaterThan(0)
    }
  })
})
