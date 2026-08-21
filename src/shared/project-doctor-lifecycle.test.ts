/**
 * The lifecycle keys are the ONLY surviving record of what happened to an
 * archived card, so most of these tests are about a record that lies rather than
 * a record that is missing: a reason on a live card, a pointer at a card that
 * was never there, a loop that leaves no survivor at all.
 *
 * The other half is silence. Every check here fires on a key that most cards
 * never carry, so a false positive is a warning on a card nobody touched -- and
 * a doctor that nags is a doctor that gets switched off.
 */

import { describe, expect, test } from 'bun:test'
import { checkLifecycleKeys, duplicateTargetOf, type LifecycleBoard } from './project-doctor-lifecycle'

const NOW = Date.parse('2026-08-21T12:00:00Z')

/** A board built from `id -> duplicate-of target`. Every named id exists. */
function board(targets: Record<string, string> = {}, extraIds: string[] = [], writtenAt?: number): LifecycleBoard {
  const ids = new Set([...Object.keys(targets), ...Object.values(targets), ...extraIds])
  return {
    has: id => ids.has(id),
    duplicateTarget: id => targets[id] ?? null,
    ...(writtenAt === undefined ? {} : { writtenAt }),
  }
}

const checks = (findings: { check: string }[]) => findings.map(f => f.check)

const archived = (meta: Record<string, unknown>) => ({
  id: 'a',
  meta: { status: 'archived', archived_by: 'report-2026-08-22', created: '2026-01-01', ...meta },
})

describe('duplicateTargetOf', () => {
  test('reads the id out of the one reason that is a pointer', () => {
    expect(duplicateTargetOf('duplicate-of:other-card')).toBe('other-card')
    expect(duplicateTargetOf('  duplicate-of: other-card  ')).toBe('other-card')
  })

  test('a reason that is not a duplicate is not a pointer -- null, not empty', () => {
    expect(duplicateTargetOf('done')).toBeNull()
    expect(duplicateTargetOf('cold')).toBeNull()
    expect(duplicateTargetOf(undefined)).toBeNull()
    expect(duplicateTargetOf(['duplicate-of:x'])).toBeNull()
  })

  test('the prefix with no id reads as EMPTY, which is a finding and not a miss', () => {
    expect(duplicateTargetOf('duplicate-of:')).toBe('')
  })
})

describe('a card with no lifecycle keys is silent', () => {
  test('nothing at all', () => {
    expect(checkLifecycleKeys({ id: 'a', meta: { status: 'open', title: 'T' } }, board())).toEqual([])
  })

  test('an empty key asserts nothing, so it is not a finding either', () => {
    const meta = { status: 'open', archived_reason: '', delete_at: '   ' }
    expect(checkLifecycleKeys({ id: 'a', meta }, board())).toEqual([])
  })
})

describe('archived_reason requires an archived lane', () => {
  test('a reason on a live card is reported, and the finding names the lane it is in', () => {
    const found = checkLifecycleKeys({ id: 'a', meta: { status: 'open', archived_reason: 'done' } }, board())
    expect(checks(found)).toContain('lifecycle-reason-not-archived')
    expect(found[0].problem).toContain('`open`')
  })

  test('a card with no lane at all renders as inbox -- also not archived', () => {
    const found = checkLifecycleKeys({ id: 'a', meta: { archived_reason: 'cold', archived_by: 'x' } }, board())
    expect(checks(found)).toEqual(['lifecycle-reason-not-archived'])
    expect(found[0].problem).toContain('`inbox`')
  })

  test('and an archived card with a reason and an actor is silent', () => {
    expect(checkLifecycleKeys(archived({ archived_reason: 'done' }), board())).toEqual([])
  })
})

describe('archived_by', () => {
  test('a reason with no actor is an unattributed mutation', () => {
    const found = checkLifecycleKeys({ id: 'a', meta: { status: 'archived', archived_reason: 'cold' } }, board())
    expect(checks(found)).toEqual(['lifecycle-archived-by-missing'])
  })

  test("an actor with no reason is nobody's business -- the pair is only required one way", () => {
    expect(checkLifecycleKeys({ id: 'a', meta: { status: 'archived', archived_by: 'me' } }, board())).toEqual([])
  })
})

describe('duplicate-of must resolve', () => {
  test('a target this board does not have', () => {
    const found = checkLifecycleKeys(archived({ archived_reason: 'duplicate-of:gone' }), board({}, ['a']))
    expect(checks(found)).toEqual(['lifecycle-duplicate-missing'])
    expect(found[0].problem).toContain('gone')
  })

  test('a target that DOES exist is silent', () => {
    const found = checkLifecycleKeys(archived({ archived_reason: 'duplicate-of:real' }), board({}, ['a', 'real']))
    expect(found).toEqual([])
  })

  test('the prefix with no id names no card', () => {
    const found = checkLifecycleKeys(archived({ archived_reason: 'duplicate-of:' }), board({}, ['a']))
    expect(checks(found)).toEqual(['lifecycle-duplicate-missing'])
    expect(found[0].problem).toContain('names no card')
  })

  test('a card may not be its own duplicate -- and that is an ERROR, not rot', () => {
    const found = checkLifecycleKeys(archived({ archived_reason: 'duplicate-of:a' }), board({ a: 'a' }))
    expect(checks(found)).toEqual(['lifecycle-duplicate-self'])
    expect(found[0].severity).toBe('error')
  })
})

describe('duplicate-of cycles leave no survivor', () => {
  test('A -> B -> A', () => {
    const found = checkLifecycleKeys(archived({ archived_reason: 'duplicate-of:b' }), board({ a: 'b', b: 'a' }))
    expect(checks(found)).toEqual(['lifecycle-duplicate-cycle'])
    expect(found[0].severity).toBe('error')
    expect(found[0].problem).toContain('a -> b -> a')
  })

  test('a longer loop, A -> B -> C -> A', () => {
    const found = checkLifecycleKeys(archived({ archived_reason: 'duplicate-of:b' }), board({ a: 'b', b: 'c', c: 'a' }))
    expect(checks(found)).toEqual(['lifecycle-duplicate-cycle'])
  })

  test('a chain that reaches a live card is fine, however long', () => {
    const found = checkLifecycleKeys(archived({ archived_reason: 'duplicate-of:b' }), board({ a: 'b', b: 'c' }, ['c']))
    expect(found).toEqual([])
  })

  test('a loop this card merely POINTS INTO is still a loop -- its survivor is unfindable too', () => {
    const found = checkLifecycleKeys(archived({ archived_reason: 'duplicate-of:b' }), board({ a: 'b', b: 'c', c: 'b' }))
    expect(checks(found)).toEqual(['lifecycle-duplicate-cycle'])
  })
})

describe('delete_at', () => {
  const clock = (targets = {}) => board(targets, ['a'], NOW)

  test('a future ISO date is silent, date-only or full', () => {
    expect(checkLifecycleKeys({ id: 'a', meta: { status: 'open', delete_at: '2026-09-30' } }, clock())).toEqual([])
    expect(
      checkLifecycleKeys({ id: 'a', meta: { status: 'open', delete_at: '2026-09-30T00:00:00Z' } }, clock()),
    ).toEqual([])
  })

  test('a date the board can parse but is not ISO 8601', () => {
    const found = checkLifecycleKeys({ id: 'a', meta: { status: 'open', delete_at: 'Sep 30 2026' } }, clock())
    expect(checks(found)).toEqual(['lifecycle-delete-at-invalid'])
  })

  test('a space instead of a T is the one near-miss `Date.parse` accepts and ISO does not', () => {
    const found = checkLifecycleKeys({ id: 'a', meta: { status: 'open', delete_at: '2026-09-30 00:00:00' } }, clock())
    expect(checks(found)).toEqual(['lifecycle-delete-at-invalid'])
  })

  test('an unreadable string is left to the registry, which already reports it once', () => {
    expect(checkLifecycleKeys({ id: 'a', meta: { status: 'open', delete_at: 'soon' } }, clock())).toEqual([])
  })

  test('a date already elapsed when written', () => {
    const found = checkLifecycleKeys({ id: 'a', meta: { status: 'open', delete_at: '2026-08-01' } }, clock())
    expect(checks(found)).toEqual(['lifecycle-delete-at-past'])
  })

  test('and board-wide -- no clock -- an elapsed marker is the NORMAL state, so it is silent', () => {
    const noClock = board({}, ['a'])
    expect(checkLifecycleKeys({ id: 'a', meta: { status: 'open', delete_at: '2020-01-01' } }, noClock)).toEqual([])
  })

  test('a card cannot expire before it exists', () => {
    const meta = { status: 'open', created: '2026-08-10T00:00:00Z', delete_at: '2026-08-09' }
    const found = checkLifecycleKeys({ id: 'a', meta }, board({}, ['a']))
    expect(checks(found)).toEqual(['lifecycle-delete-at-before-start'])
    expect(found[0].problem).toContain('created')
  })

  test('`archived_at` wins over `created` when the card carries one', () => {
    const meta = {
      status: 'archived',
      created: '2026-01-01',
      archived_at: '2026-08-10T00:00:00Z',
      delete_at: '2026-08-09',
    }
    const found = checkLifecycleKeys({ id: 'a', meta }, board({}, ['a']))
    expect(found[0].problem).toContain('archived_at')
  })

  test('before-created and already-elapsed are ONE mistake -- it is reported once', () => {
    const meta = { status: 'open', created: '2026-08-10T00:00:00Z', delete_at: '2026-08-09' }
    expect(checks(checkLifecycleKeys({ id: 'a', meta }, clock()))).toEqual(['lifecycle-delete-at-before-start'])
  })
})

describe('every finding is actionable', () => {
  test('each one carries a problem and a remedy', () => {
    const cases: Record<string, unknown>[] = [
      { status: 'open', archived_reason: 'done' },
      { status: 'archived', archived_reason: 'cold' },
      { status: 'archived', archived_by: 'x', archived_reason: 'duplicate-of:gone' },
      { status: 'archived', archived_by: 'x', archived_reason: 'duplicate-of:a' },
      { status: 'open', delete_at: 'Sep 30 2026' },
      { status: 'open', created: '2026-08-10', delete_at: '2026-08-09' },
    ]
    for (const meta of cases) {
      const found = checkLifecycleKeys({ id: 'a', meta }, board({ a: 'a' }, ['a'], NOW))
      expect(found.length).toBeGreaterThan(0)
      for (const f of found) {
        expect(f.problem.length).toBeGreaterThan(0)
        expect(f.remedy.length).toBeGreaterThan(0)
        expect(f.subject).toBe('a')
        expect(f.check.startsWith('lifecycle-')).toBe(true)
      }
    }
  })
})
