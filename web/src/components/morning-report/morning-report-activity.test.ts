/**
 * What the parked tile says, and when it blinks.
 *
 * The claim worth a test: NO BREW IS AN ERROR, not an idle surface. A missing
 * morning report is the only liveness signal this feature has, and a tile that
 * renders it as "nothing going on" is how the other unattended engines here died
 * without anybody noticing.
 */

import { archiveCold, noteDeleteAt } from '@shared/board-sweep-proposals'
import type { BoardReportRecord } from '@shared/protocol'
import { describe, expect, it } from 'vitest'
import { morningReportActivity } from './morning-report-activity'
import type { MorningReportState } from './use-morning-report'

function report(over: Partial<BoardReportRecord> = {}): BoardReportRecord {
  return {
    project: 'claude://default/p',
    date: '2026-08-22',
    tz: 'Europe/Berlin',
    reportPath: '.rclaude/project/reports/2026-08-22.md',
    proposals: [archiveCold({ card: 'cold-one', created: '2026-01-01T00:00:00Z', ageDays: 233 })],
    snapshot: 'head:600:1',
    skipped: false,
    selected: 9,
    acted: 1,
    refused: 8,
    sweptAt: 0,
    ...over,
  }
}

function state(over: Partial<MorningReportState> = {}): MorningReportState {
  return {
    report: report(),
    loading: false,
    error: null,
    executing: false,
    outcomes: {},
    selection: new Set(),
    toggleRow: () => {},
    onTickAll: () => {},
    onUntickAll: () => {},
    execute: () => {},
    ...over,
  }
}

describe('the dock tile', () => {
  it('NO BREW IS AN ERROR, never idle', () => {
    expect(morningReportActivity(state({ report: null }))).toMatchObject({
      status: 'error',
      label: 'no report yet',
    })
  })

  it('names the date and the count of things you could actually execute', () => {
    expect(morningReportActivity(state())).toMatchObject({
      status: 'done',
      label: '2026-08-22: 1 proposal',
      tick: '2026-08-22',
    })
  })

  it('a report of nothing but markers has NO proposals to execute', () => {
    // `note-delete-at` is never executed here, so counting it would promise a
    // button that does nothing.
    const markersOnly = report({
      proposals: [noteDeleteAt({ card: 'doomed', deleteAt: '2026-01-01', elapsedDays: 9 })],
    })
    expect(morningReportActivity(state({ report: markersOnly })).label).toBe('2026-08-22: no proposals')
  })

  it('a short-circuited sweep says nothing moved, which is not a failure', () => {
    const skipped = report({ skipped: true, proposals: [] })
    expect(morningReportActivity(state({ report: skipped }))).toMatchObject({
      status: 'done',
      label: '2026-08-22: nothing moved',
    })
  })

  it('THE TICK IS THE REPORT DATE, so the tile blinks once per brew and not per render', () => {
    const a = morningReportActivity(state())
    const b = morningReportActivity(state())
    expect(a.tick).toBe(b.tick)
    expect(morningReportActivity(state({ report: report({ date: '2026-08-23' }) })).tick).toBe('2026-08-23')
  })

  it('a failure outranks everything', () => {
    expect(morningReportActivity(state({ error: 'broker said no', executing: true }))).toMatchObject({
      status: 'error',
      label: 'broker said no',
    })
  })

  it('an execute in flight is a run', () => {
    expect(morningReportActivity(state({ executing: true }))).toMatchObject({ status: 'running', label: 'executing' })
  })
})
