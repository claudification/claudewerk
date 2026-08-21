/**
 * The morning report's two verbs, at the broker.
 *
 * THE TWO PROPERTIES WORTH BREAKING THE BUILD OVER:
 *
 *  1. `latest` NEVER TOUCHES THE SENTINEL. Opening the surface renders what the
 *     schedule already produced. A panel that sweeps on open can never visibly
 *     fail, and a missing brew is the only liveness signal this feature has.
 *
 *  2. THE OUTCOME IS READ, NOT ASSUMED. Every audit row for an executed proposal
 *     comes from what `apply` reported back after writing the file. A failed card
 *     write that leaves a log reading "moved" is the exact class of
 *     confident-but-untrue record this epic exists to prevent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveCold, flagDuplicate, noteDeleteAt, promoteDelivered } from '../../shared/board-sweep-proposals'
import type { BoardApplyOutcome, BoardReportRecord } from '../../shared/protocol'
import { closeBoardAudit, initBoardAudit, listBoardActions, recordBoardReport } from '../board-audit'
import { GuardError, type HandlerContext } from '../handler-context'
import { boardReportRequest } from './board-report'

const PROJECT = 'claude://default/p'
const DATE = '2026-08-22'
const NOW = Date.parse('2026-08-22T06:00:00Z')

let dir: string

function report(over: Partial<BoardReportRecord> = {}): BoardReportRecord {
  return {
    project: PROJECT,
    date: DATE,
    tz: 'Europe/Berlin',
    reportPath: `.rclaude/project/reports/${DATE}.md`,
    proposals: [
      promoteDelivered({ card: 'shipped', from: 'open', closes: ['abc1234'] }),
      archiveCold({ card: 'cold-one', created: '2026-01-01T00:00:00Z', ageDays: 233 }),
      flagDuplicate({ card: 'twin-a', other: 'twin-b', confidence: 0.8, reason: 'same title' }),
      noteDeleteAt({ card: 'doomed', deleteAt: '2026-01-01', elapsedDays: 233 }),
    ],
    snapshot: 'head:600:1',
    skipped: false,
    selected: 9,
    acted: 4,
    refused: 5,
    sweptAt: NOW,
    ...over,
  }
}

/**
 * A context whose sentinel answers `apply` with canned outcomes.
 *
 * The RPC is driven for real (`callBoard` -> listener -> send -> reply) rather
 * than stubbed: the ordering this file exists to pin is "the write happened,
 * THEN we logged it", and a stub that resolves before the send would make an
 * out-of-order implementation pass.
 */
function makeCtx(opts: { applied?: BoardApplyOutcome[]; rpcOk?: boolean; denyPermission?: boolean } = {}) {
  const replies: Record<string, unknown>[] = []
  const perms: Array<{ perm: string; project?: string }> = []
  const sentToSentinel: Record<string, unknown>[] = []
  const listeners = new Map<string, (msg: Record<string, unknown>) => void>()

  const sentinel = {
    send(raw: string) {
      const msg = JSON.parse(raw) as Record<string, unknown>
      sentToSentinel.push(msg)
      const requestId = msg.requestId as string
      // Answer on a later turn, exactly as a real socket would.
      queueMicrotask(() => {
        listeners.get(requestId)?.(
          opts.rpcOk === false ? { ok: false, error: 'sentinel timed out (10s)' } : { ok: true, applied: opts.applied },
        )
      })
    },
  }

  const ctx = {
    ws: { data: { isControlPanel: true } },
    conversations: {
      getSentinel: () => sentinel,
      getSentinelByAlias: () => sentinel,
      addProjectListener: (id: string, cb: (msg: Record<string, unknown>) => void) => listeners.set(id, cb),
      removeProjectListener: (id: string) => listeners.delete(id),
    },
    requirePermission: (perm: string, project?: string) => {
      perms.push({ perm, project })
      if (opts.denyPermission) throw new GuardError('Forbidden')
    },
    reply: (msg: Record<string, unknown>) => replies.push(msg),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as HandlerContext

  return { ctx, replies, perms, sentToSentinel }
}

function execute(proposals: Array<{ kind: string; card: string; other?: string }>, date = DATE) {
  return {
    type: 'board_report_request',
    requestId: 'r1',
    project: PROJECT,
    op: 'execute',
    execute: { proposals, date },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-report-handler-'))
  initBoardAudit(dir)
})
afterEach(() => {
  closeBoardAudit()
  rmSync(dir, { recursive: true, force: true })
})

describe('`latest` is a pure read and stops at the broker', () => {
  test('it answers from the sidecar and NEVER sends the sentinel anything', async () => {
    recordBoardReport(report())
    const { ctx, replies, sentToSentinel } = makeCtx()

    await boardReportRequest(ctx, { type: 'board_report_request', requestId: 'r1', project: PROJECT, op: 'latest' })

    // The property the whole feature rests on: opening the surface triggers no
    // sweep, because there is no verb here that could start one.
    expect(sentToSentinel).toHaveLength(0)
    expect(replies[0]).toMatchObject({ type: 'board_report_result', requestId: 'r1', ok: true })
    expect((replies[0].report as BoardReportRecord).date).toBe(DATE)
  })

  test('no brew ever -> ok with a null report, not an error', async () => {
    const { ctx, replies } = makeCtx()
    await boardReportRequest(ctx, { type: 'board_report_request', requestId: 'r1', project: PROJECT, op: 'latest' })
    expect(replies[0]).toMatchObject({ ok: true, report: null })
  })

  test('a read is gated as a read', async () => {
    const { ctx, perms } = makeCtx()
    await boardReportRequest(ctx, { type: 'board_report_request', requestId: 'r1', project: PROJECT, op: 'latest' })
    expect(perms).toEqual([{ perm: 'files:read', project: PROJECT }])
  })
})

describe('`execute` sends only what was ticked', () => {
  test('one ticked row of three reaches `apply`, and the others do not', async () => {
    recordBoardReport(report())
    const { ctx, replies, sentToSentinel } = makeCtx({
      applied: [{ kind: 'archive-cold', card: 'cold-one', ok: true, status: 'archived', archivedReason: 'cold' }],
    })

    await boardReportRequest(ctx, execute([{ kind: 'archive-cold', card: 'cold-one' }]))

    expect(sentToSentinel).toHaveLength(1)
    expect(sentToSentinel[0]).toMatchObject({
      op: 'apply',
      apply: { proposals: [{ kind: 'archive-cold', card: 'cold-one' }], tz: 'Europe/Berlin', reportDate: DATE },
    })
    expect(replies[0]).toMatchObject({ ok: true })
  })

  test('the zone comes from the REPORT, never from the caller', async () => {
    // 23:30 UTC is the next day in Berlin. `archived_by: report-<date>` has to
    // be stamped in the zone the report was dated in, or the backlink names a
    // report that does not exist.
    recordBoardReport(report({ tz: 'Asia/Bangkok' }))
    const { ctx, sentToSentinel } = makeCtx({ applied: [] })
    await boardReportRequest(ctx, execute([{ kind: 'archive-cold', card: 'cold-one' }]))
    expect(sentToSentinel[0]).toMatchObject({ apply: { tz: 'Asia/Bangkok', reportDate: DATE } })
  })

  test('a card the report never proposed refuses the WHOLE press, before any write', async () => {
    recordBoardReport(report())
    const { ctx, replies, sentToSentinel } = makeCtx({ applied: [] })

    await boardReportRequest(
      ctx,
      execute([
        { kind: 'archive-cold', card: 'cold-one' },
        { kind: 'archive-cold', card: 'never-proposed' },
      ]),
    )

    expect(sentToSentinel).toHaveLength(0)
    expect(replies[0]).toMatchObject({ ok: false })
    expect(String(replies[0].error)).toContain('never-proposed')
    expect(listBoardActions(PROJECT)).toHaveLength(0)
  })

  test('`other` is taken from the report, so a caller cannot re-point a duplicate', async () => {
    recordBoardReport(report())
    const { ctx, sentToSentinel } = makeCtx({ applied: [] })
    await boardReportRequest(ctx, execute([{ kind: 'flag-duplicate', card: 'twin-a', other: 'somebody-else' }]))
    expect(sentToSentinel[0]).toMatchObject({ apply: { proposals: [{ card: 'twin-a', other: 'twin-b' }] } })
  })

  test('a stale tick list is refused rather than applied to a newer board', async () => {
    recordBoardReport(report({ date: '2026-08-23' }))
    const { ctx, replies, sentToSentinel } = makeCtx({ applied: [] })
    await boardReportRequest(ctx, execute([{ kind: 'archive-cold', card: 'cold-one' }], '2026-08-22'))
    expect(sentToSentinel).toHaveLength(0)
    expect(String(replies[0].error)).toContain('no longer current')
  })

  test('nothing ticked is a refusal, not an empty apply', async () => {
    recordBoardReport(report())
    const { ctx, replies, sentToSentinel } = makeCtx()
    await boardReportRequest(ctx, execute([]))
    expect(sentToSentinel).toHaveLength(0)
    expect(replies[0]).toMatchObject({ ok: false, error: 'nothing was ticked' })
  })

  test('an execute is gated as a WRITE', async () => {
    recordBoardReport(report())
    const { ctx, perms } = makeCtx({ applied: [] })
    await boardReportRequest(ctx, execute([{ kind: 'archive-cold', card: 'cold-one' }]))
    expect(perms).toEqual([{ perm: 'files', project: PROJECT }])
  })

  test('F18 stays at the OP: a hand-crafted note-delete-at is forwarded and refused there', async () => {
    // Deliberately NOT filtered here. `apply` gates on kind (not on a checkbox)
    // and is the strong gate; a second, weaker copy in the broker is the one
    // that would drift. What comes back is a real refusal from the process that
    // owns the files, and it is recorded as such.
    recordBoardReport(report())
    const { ctx, replies } = makeCtx({
      applied: [{ kind: 'note-delete-at', card: 'doomed', ok: false, error: 'note-delete-at is never executed (F18)' }],
    })

    await boardReportRequest(ctx, execute([{ kind: 'note-delete-at', card: 'doomed' }]))

    expect((replies[0].applied as BoardApplyOutcome[])[0].ok).toBe(false)
    const outcome = listBoardActions(PROJECT).find(r => r.phase === 'outcome')
    expect(outcome).toMatchObject({ kind: 'note-delete-at', ok: false })
  })
})

describe('the record of having pressed it', () => {
  test('two rows per proposal: intent first, then the outcome that was READ BACK', async () => {
    recordBoardReport(report())
    const { ctx } = makeCtx({
      applied: [{ kind: 'archive-cold', card: 'cold-one', ok: true, status: 'archived', archivedReason: 'cold' }],
    })

    await boardReportRequest(ctx, execute([{ kind: 'archive-cold', card: 'cold-one' }]))

    const rows = listBoardActions(PROJECT)
    expect(rows.map(r => r.phase)).toEqual(['outcome', 'intent'])
    expect(rows[0]).toMatchObject({ ok: true, status: 'archived', archivedReason: 'cold', reportDate: DATE })
    expect(rows[0].traceId).toBe(rows[1].traceId)
  })

  test('A FAILED CARD WRITE IS LOGGED AS A FAILURE while its neighbour still moves', async () => {
    recordBoardReport(report())
    const { ctx, replies } = makeCtx({
      applied: [
        { kind: 'archive-cold', card: 'cold-one', ok: true, status: 'archived', archivedReason: 'cold' },
        { kind: 'promote-delivered', card: 'shipped', ok: false, error: 'no such card' },
      ],
    })

    await boardReportRequest(
      ctx,
      execute([
        { kind: 'archive-cold', card: 'cold-one' },
        { kind: 'promote-delivered', card: 'shipped' },
      ]),
    )

    const outcomes = listBoardActions(PROJECT).filter(r => r.phase === 'outcome')
    expect(outcomes.find(o => o.card === 'cold-one')?.ok).toBe(true)
    expect(outcomes.find(o => o.card === 'shipped')).toMatchObject({ ok: false, error: 'no such card' })
    // Per-proposal all the way out to the caller -- never collapsed to one boolean.
    expect((replies[0].applied as BoardApplyOutcome[]).map(o => o.ok)).toEqual([true, false])
  })

  test('an apply that never came back CLOSES the ledger with failures', async () => {
    // An intent with no outcome beside it reads as "still running" forever. The
    // transport failed, nothing was read off disk, so nothing may claim to have
    // moved.
    recordBoardReport(report())
    const { ctx, replies } = makeCtx({ rpcOk: false })

    await boardReportRequest(ctx, execute([{ kind: 'archive-cold', card: 'cold-one' }]))

    const rows = listBoardActions(PROJECT)
    expect(rows.map(r => r.phase)).toEqual(['outcome', 'intent'])
    expect(rows[0]).toMatchObject({ ok: false, error: 'sentinel timed out (10s)' })
    expect(replies[0]).toMatchObject({ ok: false, error: 'sentinel timed out (10s)' })
  })

  test('an `ok` with no outcomes is a failure, not a silent success', async () => {
    // What an older sentinel that does not know the op looks like from here.
    recordBoardReport(report())
    const { ctx, replies } = makeCtx({ applied: undefined })

    await boardReportRequest(ctx, execute([{ kind: 'archive-cold', card: 'cold-one' }]))

    expect(replies[0].ok).toBe(false)
    expect(String(replies[0].error)).toContain('apply')
    expect(listBoardActions(PROJECT).find(r => r.phase === 'outcome')?.ok).toBe(false)
  })
})
