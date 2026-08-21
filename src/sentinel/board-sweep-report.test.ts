/**
 * The brew, as a string.
 *
 * Pure input -> pure output, so every shape a morning can take -- a full report,
 * an empty one, a short-circuited one -- is exercised with no board, no clock
 * and no filesystem. What is on trial is what a human reads at 08:00: that the
 * checkboxes match D6, that a `delete_at` row cannot look actionable, and that
 * the file never renders a bare time.
 */

import { describe, expect, test } from 'bun:test'
import { archiveCold, flagDuplicate, noteDeleteAt, promoteDelivered } from '../shared/board-sweep-proposals'
import { type BoardReportInput, renderBoardReport, reportDateIn } from './board-sweep-report'

const BERLIN = 'Europe/Berlin'
/** 2026-08-22 01:30 Berlin == 2026-08-21 23:30 UTC. */
const NOW = Date.parse('2026-08-21T23:30:00Z')

function input(over: Partial<BoardReportInput> = {}): BoardReportInput {
  return {
    project: 'claude:///p',
    date: '2026-08-22',
    nowMs: NOW,
    tz: BERLIN,
    proposals: [],
    selected: [],
    acted: [],
    refused: [],
    snapshot: 'abc123:12:1700000000000',
    skipped: false,
    duplicateJudgeAbsent: false,
    ...over,
  }
}

describe('reportDateIn', () => {
  test('dates in the given zone, never the container clock', () => {
    expect(reportDateIn(NOW, BERLIN)).toBe('2026-08-22')
    expect(reportDateIn(NOW, 'UTC')).toBe('2026-08-21')
    // Far enough west that the same instant is still the day before.
    expect(reportDateIn(NOW, 'America/Los_Angeles')).toBe('2026-08-21')
  })

  test('pads a single-digit month and day', () => {
    expect(reportDateIn(Date.parse('2026-01-05T12:00:00Z'), 'UTC')).toBe('2026-01-05')
  })
})

describe('the proposal sections', () => {
  const PROPOSALS = [
    promoteDelivered({ card: 'shipped-thing', from: 'open', closes: ['abc1234'] }),
    archiveCold({ card: 'stale-thing', created: '2026-01-01', ageDays: 233 }),
    flagDuplicate({ card: 'twin-a', other: 'twin-b', confidence: 0.8, reason: 'same feature' }),
    noteDeleteAt({ card: 'marked-thing', deleteAt: '2026-08-01', elapsedDays: 21 }),
  ]

  test('D6 -- the fact-derived reversible kinds arrive ticked, the other two do not', () => {
    const text = renderBoardReport(input({ proposals: PROPOSALS }))
    expect(text).toContain('- [x] `shipped-thing`')
    expect(text).toContain('- [x] `stale-thing`')
    expect(text).toContain('- [ ] `twin-a`')
    expect(text).toContain('- [ ] `marked-thing`')
  })

  test('the delete marker says out loud that nothing acts on it', () => {
    const text = renderBoardReport(input({ proposals: PROPOSALS }))
    expect(text).toContain('never executed here')
    expect(text).toContain('refuses that kind outright')
  })

  test('a kind with no rows gets no heading at all', () => {
    const text = renderBoardReport(input({ proposals: [PROPOSALS[1]] }))
    expect(text).toContain('Cold in `inbox`')
    expect(text).not.toContain('Possible duplicates')
  })

  test('the stamp carries its zone -- nothing renders a bare time', () => {
    expect(renderBoardReport(input())).toContain(`2026-08-22 01:30 ${BERLIN}`)
  })
})

describe('the denominator', () => {
  test('the census counts refusals by bucket, biggest first', () => {
    const text = renderBoardReport(
      input({
        selected: ['a', 'b', 'c'],
        acted: ['a'],
        refused: [
          { unit: 'b', bucket: 'not-cold-yet', detail: '2d old' },
          { unit: 'c', bucket: 'not-cold-yet', detail: '3d old' },
          { unit: 'd', bucket: 'live-conversation', detail: 'being worked' },
        ],
      }),
    )
    expect(text).toContain('3 candidate card(s) considered, 1 earned a proposal.')
    expect(text.indexOf('`not-cold-yet` | 2')).toBeLessThan(text.indexOf('`live-conversation` | 1'))
  })

  test('an empty board says so instead of rendering a blank page', () => {
    const text = renderBoardReport(input({ idleReason: 'no card on the board is a candidate' }))
    expect(text).toContain('No proposals')
    expect(text).toContain('no card on the board is a candidate')
  })

  test('a missing duplicate judge is stated, never implied', () => {
    const text = renderBoardReport(input({ duplicateJudgeAbsent: true }))
    expect(text).toContain('duplicate pass did not run')
    // The distinction the whole line exists to make.
    expect(text).toContain('nobody looked')
  })
})

describe('the short-circuit report', () => {
  test('says nothing moved, and says it is the cheap path rather than a failure', () => {
    const text = renderBoardReport(input({ skipped: true, idleReason: 'HEAD and the board are unchanged' }))
    expect(text).toContain('Nothing moved')
    expect(text).toContain('HEAD and the board are unchanged')
    expect(text).toContain('not a failure')
  })

  test('carries no census -- it looked at nothing, so it claims nothing', () => {
    const text = renderBoardReport(input({ skipped: true }))
    expect(text).not.toContain('candidate card(s) considered')
  })
})
