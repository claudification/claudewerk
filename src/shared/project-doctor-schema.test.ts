/**
 * The registry-driven checks in isolation. The integration lives in
 * project-doctor.test.ts; what is pinned here is the three places this pass
 * deliberately says NOTHING, because each of them is a finding somebody else
 * already owns.
 */

import { describe, expect, test } from 'bun:test'
import { checkCardSchema } from './project-doctor-schema'

const checks = (meta: Record<string, unknown>, laneStatus?: string) =>
  checkCardSchema({ id: 'c', meta, laneStatus }).map(f => f.check)

const OK = { title: 'T', status: 'open', created: '2026-01-01T00:00:00.000Z' }

describe('what it reports', () => {
  test('a required key that is absent, under its shipped id', () => {
    expect(checks({ status: 'open' })).toContain('card-title-missing')
    expect(checks({ title: 'T' })).toContain('card-status-missing')
  })

  test('a key present but EMPTY is the same fact as absent', () => {
    expect(checks({ ...OK, title: '' })).toContain('card-title-missing')
  })

  test('an unusable lane keeps its shipped id AND its error severity', () => {
    const found = checkCardSchema({ id: 'c', meta: { ...OK, status: 'nope' } })
    expect(found.map(f => f.check)).toContain('card-status-invalid')
    expect(found.find(f => f.check === 'card-status-invalid')?.severity).toBe('error')
  })

  test('any other known key of the wrong type lands on one generic id', () => {
    expect(checks({ ...OK, tags: 'a, b' })).toEqual(['card-key-type'])
    expect(checks({ ...OK, evidence_commits: 'four' })).toEqual(['card-key-type'])
  })

  test('every finding carries a problem AND a remedy', () => {
    for (const finding of checkCardSchema({ id: 'c', meta: { status: 'nope', tags: 'x, y' } })) {
      expect(finding.problem.length).toBeGreaterThan(0)
      expect(finding.remedy.length).toBeGreaterThan(0)
    }
  })
})

describe('what it deliberately stays quiet about', () => {
  test('an undeclared key -- OPEN is a promise, not a default', () => {
    expect(checks({ ...OK, evidence_invented: 'x', whatever: ['a'] })).toEqual([])
  })

  test('a LINKAGE key of the wrong shape -- project-doctor-linkage.ts owns that', () => {
    expect(checks({ ...OK, epic: ['a', 'b'], refs: 'one.md' })).toEqual([])
  })

  test('an absent `created:` -- project-doctor-created.ts REPAIRS it instead', () => {
    expect(checks({ title: 'T', status: 'open' })).toEqual([])
  })

  test('a legacy-lane card missing `status:` -- its directory IS its status', () => {
    expect(checks({ title: 'T', created: OK.created }, 'open')).toEqual([])
    // ...but the lane never excuses a lane value the board cannot read.
    expect(checks({ ...OK, status: 'nope' }, 'open')).toContain('card-status-invalid')
  })
})
