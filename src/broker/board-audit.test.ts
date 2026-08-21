/**
 * The board audit sidecar: the recorded brew the surface renders, and the
 * two-row-per-proposal ledger behind "what happened to this card?".
 *
 * What is pinned here is the shape of the RECORD, not the wiring: a report
 * survives having no successor (staleness is a rendering problem, never a
 * deletion), a re-record of the same date replaces rather than duplicates, and
 * an outcome row can never be mistaken for the intent that preceded it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveCold, noteDeleteAt, promoteDelivered } from '../shared/board-sweep-proposals'
import type { BoardReportRecord } from '../shared/protocol'
import {
  closeBoardAudit,
  initBoardAudit,
  latestBoardReport,
  listBoardActions,
  purgeBoardActions,
  recordBoardIntent,
  recordBoardOutcome,
  recordBoardReport,
} from './board-audit'

const PROJECT = 'claude://default/p'
const OTHER_PROJECT = 'claude://default/q'
const DAY = 86_400_000
const NOW = Date.parse('2026-08-22T06:00:00Z')

let dir: string

function report(over: Partial<BoardReportRecord> = {}): BoardReportRecord {
  return {
    project: PROJECT,
    date: '2026-08-22',
    tz: 'Europe/Berlin',
    reportPath: '.rclaude/project/reports/2026-08-22.md',
    proposals: [
      promoteDelivered({ card: 'shipped-thing', from: 'open', closes: ['abc1234'] }),
      archiveCold({ card: 'old-idea', created: '2026-01-01T00:00:00Z', ageDays: 233 }),
    ],
    snapshot: 'head:600:1',
    skipped: false,
    selected: 9,
    acted: 2,
    refused: 7,
    sweptAt: NOW,
    ...over,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-audit-'))
  initBoardAudit(dir)
})
afterEach(() => {
  closeBoardAudit()
  rmSync(dir, { recursive: true, force: true })
})

describe('the recorded brew', () => {
  test('no sweep has ever landed -> null, which is an ANSWER and not an error', () => {
    // The surface renders this as "no brew has ever arrived". It must never be a
    // reason to go and compute one.
    expect(latestBoardReport(PROJECT)).toBeNull()
  })

  test('proposals survive the round trip with their kinds and payloads intact', () => {
    recordBoardReport(report())
    const back = latestBoardReport(PROJECT)
    expect(back?.date).toBe('2026-08-22')
    expect(back?.tz).toBe('Europe/Berlin')
    expect(back?.proposals.map(p => p.kind)).toEqual(['promote-delivered', 'archive-cold'])
    expect(back?.proposals[0]).toMatchObject({ card: 'shipped-thing', to: 'done', closes: ['abc1234'] })
    expect(back?.proposals[1]).toMatchObject({ card: 'old-idea', ageDays: 233, checked: true })
    expect(back?.selected).toBe(9)
    expect(back?.refused).toBe(7)
  })

  test('THE STALENESS PROPERTY: a report with no successor is still there', () => {
    // The whole reason a report is recorded rather than derived. "From Tuesday"
    // is honest; an empty panel is ambiguous between "nothing happened" and "the
    // sweep is broken", and that ambiguity is how the other unattended engines
    // died quietly.
    recordBoardReport(report({ date: '2026-08-18', sweptAt: NOW - 4 * DAY }))
    const back = latestBoardReport(PROJECT)
    expect(back?.date).toBe('2026-08-18')
    expect(back?.sweptAt).toBe(NOW - 4 * DAY)
  })

  test('the LATEST is by report date, not by when it was written', () => {
    // A re-record bumps `swept_at`; the report a human means by "the latest one"
    // is the one with the newest name on it.
    recordBoardReport(report({ date: '2026-08-22', sweptAt: NOW - 10 * DAY }))
    recordBoardReport(report({ date: '2026-08-18', sweptAt: NOW }))
    expect(latestBoardReport(PROJECT)?.date).toBe('2026-08-22')
  })

  test('sweeping the same date twice REPLACES it -- one morning is one report', () => {
    recordBoardReport(report())
    recordBoardReport(report({ proposals: [], acted: 0, snapshot: 'head:601:2' }))
    const back = latestBoardReport(PROJECT)
    expect(back?.proposals).toEqual([])
    expect(back?.snapshot).toBe('head:601:2')
  })

  test('projects do not read each other', () => {
    recordBoardReport(report())
    expect(latestBoardReport(OTHER_PROJECT)).toBeNull()
  })

  test('a short-circuited sweep is recorded AS short-circuited', () => {
    recordBoardReport(report({ skipped: true, proposals: [], acted: 0 }))
    expect(latestBoardReport(PROJECT)?.skipped).toBe(true)
  })
})

describe('the two-row ledger', () => {
  const proposal = { kind: 'archive-cold' as const, card: 'old-idea' }

  test('intent is written before the outcome, and they are distinct rows', () => {
    recordBoardIntent({ project: PROJECT, reportDate: '2026-08-22', proposal, traceId: 't1', ts: NOW })
    recordBoardOutcome({
      project: PROJECT,
      reportDate: '2026-08-22',
      outcome: { kind: 'archive-cold', card: 'old-idea', ok: true, status: 'archived', archivedReason: 'cold' },
      traceId: 't1',
      ts: NOW + 5,
    })

    const rows = listBoardActions(PROJECT)
    expect(rows).toHaveLength(2)
    // Newest first: the outcome, then the intent it closes.
    expect(rows[0]).toMatchObject({ phase: 'outcome', ok: true, status: 'archived', archivedReason: 'cold' })
    expect(rows[1]).toMatchObject({ phase: 'intent', card: 'old-idea', traceId: 't1' })
    // An intent must never look like a result. `ok` is absent, not false.
    expect(rows[1].ok).toBeUndefined()
  })

  test('A FAILED WRITE IS LOGGED AS A FAILURE, never as a move', () => {
    recordBoardIntent({ project: PROJECT, reportDate: '2026-08-22', proposal, traceId: 't2', ts: NOW })
    recordBoardOutcome({
      project: PROJECT,
      reportDate: '2026-08-22',
      outcome: { kind: 'archive-cold', card: 'old-idea', ok: false, error: 'no such card' },
      traceId: 't2',
      ts: NOW + 5,
    })
    const outcome = listBoardActions(PROJECT).find(r => r.phase === 'outcome')
    expect(outcome?.ok).toBe(false)
    expect(outcome?.error).toBe('no such card')
    expect(outcome?.status).toBeUndefined()
  })

  test('a duplicate carries the card it points at', () => {
    recordBoardIntent({
      project: PROJECT,
      reportDate: '2026-08-22',
      proposal: { kind: 'flag-duplicate', card: 'a', other: 'b' },
      traceId: 't3',
      ts: NOW,
    })
    expect(listBoardActions(PROJECT)[0]).toMatchObject({ kind: 'flag-duplicate', card: 'a', other: 'b' })
  })

  test('one press of Execute shares one trace id across every row it produced', () => {
    for (const card of ['a', 'b']) {
      recordBoardIntent({
        project: PROJECT,
        reportDate: '2026-08-22',
        proposal: { kind: 'archive-cold', card },
        traceId: 't4',
        ts: NOW,
      })
    }
    expect(new Set(listBoardActions(PROJECT).map(r => r.traceId))).toEqual(new Set(['t4']))
  })

  test('a note-delete-at refusal is recorded as an outcome that did not happen', () => {
    // F18 is enforced at the op, not here -- but the refusal is still a fact
    // about a press somebody made, and it belongs in the ledger.
    const refused = noteDeleteAt({ card: 'doomed', deleteAt: '2026-01-01', elapsedDays: 233 })
    recordBoardOutcome({
      project: PROJECT,
      reportDate: '2026-08-22',
      outcome: { kind: refused.kind, card: refused.card, ok: false, error: 'note-delete-at is never executed' },
      traceId: 't5',
      ts: NOW,
    })
    expect(listBoardActions(PROJECT)[0]).toMatchObject({ kind: 'note-delete-at', ok: false })
  })
})

describe('the 30-day purge (D7)', () => {
  test('old action rows go, the report they explain STAYS', () => {
    recordBoardReport(report({ date: '2026-06-01', sweptAt: NOW - 60 * DAY }))
    recordBoardIntent({
      project: PROJECT,
      reportDate: '2026-06-01',
      proposal: { kind: 'archive-cold', card: 'ancient' },
      traceId: 'old',
      ts: NOW - 60 * DAY,
    })
    recordBoardIntent({
      project: PROJECT,
      reportDate: '2026-08-22',
      proposal: { kind: 'archive-cold', card: 'recent' },
      traceId: 'new',
      ts: NOW - DAY,
    })

    expect(purgeBoardActions(NOW)).toBe(1)
    expect(listBoardActions(PROJECT).map(r => r.card)).toEqual(['recent'])
    // The purge costs deep forensics and never costs the explanation: the
    // report, the markdown artifact and the card's own `archived_by` all remain.
    expect(latestBoardReport(PROJECT)?.date).toBe('2026-06-01')
  })
})
