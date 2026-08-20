/**
 * THE BURIAL RULE -- when a dead run leaves the pane, and when it must not.
 *
 * The two failures this pins are opposite and both real: a tail that can only
 * grow (the hole O2 left), and a run that vanishes while it is still running
 * (the hole O2 was written to close). Everything here is one or the other.
 */

import { describe, expect, test } from 'bun:test'
import { clearedReason, RUN_AGE_OUT_MS, runCleared } from './epic-run-cleared'

const NOW = Date.parse('2026-08-21T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

describe('a dead run leaving the pane', () => {
  test('an acknowledged run is cleared however recently it died', () => {
    expect(runCleared({ acknowledgedAt: iso(0), deadSince: iso(0) }, NOW)).toBe(true)
  })

  test('a dead run nobody acknowledged stays on the pane', () => {
    expect(runCleared({ deadSince: iso(60_000) }, NOW)).toBe(false)
  })

  test('a run dead longer than the age-out drops off on its own', () => {
    expect(runCleared({ deadSince: iso(RUN_AGE_OUT_MS + 1) }, NOW)).toBe(true)
  })

  /** The weekend case the constant exists for: died Friday, still there Monday. */
  test('a run dead for three days is still on the pane', () => {
    expect(runCleared({ deadSince: iso(3 * 24 * 60 * 60 * 1000) }, NOW)).toBe(false)
  })

  test('exactly at the boundary it has not aged out yet', () => {
    expect(runCleared({ deadSince: iso(RUN_AGE_OUT_MS) }, NOW)).toBe(false)
  })

  /**
   * A MISSING OR CORRUPT STAMP MUST NEVER BURY A ROW. `Date.parse` of junk is
   * NaN, and NaN arithmetic compares false everywhere -- but relying on that
   * silently would mean a hand-edited artifact could hide a run by accident.
   */
  test('no stamp, or an unparseable one, keeps the row', () => {
    expect(runCleared({}, NOW)).toBe(false)
    expect(runCleared({ deadSince: null }, NOW)).toBe(false)
    expect(runCleared({ deadSince: 'last tuesday' }, NOW)).toBe(false)
    expect(runCleared({ acknowledgedAt: '' }, NOW)).toBe(false)
  })

  test('the reason distinguishes the two ways out, and says nothing about a row that stayed', () => {
    expect(clearedReason({ acknowledgedAt: iso(0) }, NOW)).toBe('acknowledged')
    expect(clearedReason({ deadSince: iso(RUN_AGE_OUT_MS + 1) }, NOW)).toBe('aged-out')
    expect(clearedReason({ deadSince: iso(1000) }, NOW)).toBeNull()
  })
})
