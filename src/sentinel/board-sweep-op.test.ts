/**
 * `sweep` -- does the brew actually ARRIVE.
 *
 * The fold itself is pinned by `board-sweep.test.ts`; nothing here re-tests it.
 * What is on trial is the wiring the fold cannot do for itself: a dated file on
 * disk, dated in the SCHEDULE's zone, a snapshot that survives to the next run,
 * and a short-circuit that cannot destroy the morning's report.
 *
 * No git repo under the temp root, on purpose. `gitHead` answers `''` there and
 * the promise resolver answers `could not verify` -- both are the honest degraded
 * path, and a sweep that fell over on a checkout it could not read would be a
 * sweep that stops running the first time somebody points it at a plain folder.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectTask } from '../shared/project-card-write'
import { reportPath } from '../shared/project-paths'
import { runBoardSweep } from './board-sweep-op'

const BERLIN = 'Europe/Berlin'
const PROJECT = 'claude:///Users/j/remote-claude'
/** 2026-08-22 01:30 Berlin == 2026-08-21 23:30 UTC -- two different dates. */
const NOW = Date.parse('2026-08-21T23:30:00Z')
const DAY = 86_400_000

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'board-sweep-op-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A card filed `ageDays` before the sweep's clock -- `created` is what the cold
 *  rule reads, and it is stamped from the create call's own `nowMs`. */
function card(title: string, ageDays: number, status: 'inbox' | 'open' = 'inbox'): string {
  return createProjectTask(root, { title, body: 'b', status }, NOW - ageDays * DAY).slug
}

function sweep(over: { liveCards?: string[]; coldAfterDays?: number } = {}) {
  return runBoardSweep(root, PROJECT, { liveCards: over.liveCards ?? [], tz: BERLIN, ...over }, NOW)
}

describe('the artifact', () => {
  test('a dated report lands, and the date comes from the schedule zone', async () => {
    card('ancient', 90)
    const result = await sweep()

    // 23:30 UTC is 01:30 the NEXT day in Berlin. A report dated off the
    // container's clock would be filed a day early, every night, forever.
    expect(result.reportDate).toBe('2026-08-22')
    expect(result.reportPath).toBe('.rclaude/project/reports/2026-08-22.md')
    expect(result.reportWritten).toBe(true)
    expect(existsSync(reportPath(root, '2026-08-22', false))).toBe(true)
  })

  test('`reports/` does not have to exist first', async () => {
    expect(existsSync(join(root, '.rclaude/project/reports'))).toBe(false)
    await sweep()
    expect(existsSync(join(root, '.rclaude/project/reports'))).toBe(true)
  })

  test('the file carries the proposals AND what was refused', async () => {
    const old = card('ancient', 90)
    card('fresh', 1)
    await sweep()

    const text = readFileSync(reportPath(root, '2026-08-22', false), 'utf8')
    expect(text).toContain(`\`${old}\``)
    expect(text).toContain('90d ago')
    // The denominator. A report listing only proposals cannot be told apart
    // from a report that failed to look at anything.
    expect(text).toContain('candidate card(s) considered')
    expect(text).toContain('not-cold-yet')
  })

  test('the duplicate pass says NOBODY LOOKED, which is not "there are none"', async () => {
    // Two near-identical titles are what the shortlist prefilter is for; with no
    // judge injected the fold refuses the pair, and the report must say so.
    // FRESH cards deliberately: `acted` wins over `refused`, so a pair that also
    // earned an `archive-cold` would never show its duplicate refusal at all.
    card('fix the flaky login test', 1)
    card('fix the flaky login tests', 1)
    const result = await sweep()

    expect(result.refused.some(r => r.bucket === 'no-duplicate-judge')).toBe(true)
    expect(readFileSync(reportPath(root, '2026-08-22', false), 'utf8')).toContain('duplicate pass did not run')
  })
})

describe('the short-circuit', () => {
  test('an unchanged board skips the second run', async () => {
    card('ancient', 90)
    const first = await sweep()
    expect(first.skipped).toBe(false)
    expect(first.proposals.length).toBeGreaterThan(0)

    const second = await sweep()
    expect(second.skipped).toBe(true)
    expect(second.proposals).toEqual([])
    expect(second.snapshot).toBe(first.snapshot)
  })

  test('a skipped run NEVER overwrites the morning report it already wrote', async () => {
    const old = card('ancient', 90)
    await sweep()
    const brew = readFileSync(reportPath(root, '2026-08-22', false), 'utf8')
    expect(brew).toContain(`\`${old}\``)

    const second = await sweep()
    expect(second.reportWritten).toBe(false)
    // Stamping "nothing moved" over the proposals is the one way this feature
    // could destroy its own output.
    expect(readFileSync(reportPath(root, '2026-08-22', false), 'utf8')).toBe(brew)
  })

  test('a skip with no report yet still writes one -- a missing brew must MEAN something', async () => {
    card('ancient', 90)
    await sweep()
    // Same board, a new day: the snapshot still matches, so the fold skips, but
    // this date has no file. No file has to mean "the sweep did not run".
    const tomorrow = await runBoardSweep(root, PROJECT, { liveCards: [], tz: BERLIN }, NOW + DAY)
    expect(tomorrow.skipped).toBe(true)
    expect(tomorrow.reportWritten).toBe(true)
    expect(readFileSync(reportPath(root, tomorrow.reportDate, false), 'utf8')).toContain('Nothing moved')
  })

  test('a new card busts the snapshot', async () => {
    card('ancient', 90)
    await sweep()
    card('another ancient', 91)
    const third = await sweep()
    expect(third.skipped).toBe(false)
  })
})

describe('liveness crosses the wire as an ANSWER', () => {
  test('a card with a live conversation on it is refused, not proposed', async () => {
    const id = card('ancient', 90)
    const result = await sweep({ liveCards: [id] })

    expect(result.proposals).toEqual([])
    expect(result.refused).toContainEqual(expect.objectContaining({ unit: id, bucket: 'live-conversation' }))
  })

  test('an unrelated live card changes nothing', async () => {
    const id = card('ancient', 90)
    const result = await sweep({ liveCards: ['some-other-card'] })
    expect(result.acted).toEqual([id])
  })
})

describe('an empty board is an answer, not a crash', () => {
  test('no cards -> no proposals, and a report saying so', async () => {
    const result = await sweep()
    expect(result.proposals).toEqual([])
    expect(result.reportWritten).toBe(true)
    expect(readFileSync(reportPath(root, '2026-08-22', false), 'utf8')).toContain('No proposals')
  })
})
