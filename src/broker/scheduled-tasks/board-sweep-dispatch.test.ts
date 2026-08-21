/**
 * The broker half of a `board-sweep` schedule: the opt-in gate, the liveness
 * answer it puts on the wire, and its refusal to report a sweep that did not
 * happen.
 *
 * Both halves matter separately. `dispatchBoardSweep` is what runs; `fireSchedule`
 * is what decides it may -- so the gate is tested where it lives (in the fire
 * path, beside the owner re-check) and the payload is tested here.
 */

import { describe, expect, test } from 'bun:test'
import type { BoardSweepResult, Conversation } from '../../shared/protocol'
import { scannerEnabled } from '../../shared/scanner-opt-in'
import { DEFAULT_SCHEDULE_SPAWN, newScheduledTaskId, type ScheduledTask } from '../../shared/scheduled-task'
import type { BoardRpcResult } from '../board-rpc'
import { dispatchBoardSweep } from './board-sweep-dispatch'

const PROJECT = 'claude:///p'

function makeTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: newScheduledTaskId(),
    name: 'morning report',
    enabled: true,
    projectUri: PROJECT,
    cwd: '/p',
    cron: '0 6 * * *',
    tz: 'Europe/Berlin',
    catchUp: 'skip',
    overlap: 'skip',
    action: 'board-sweep',
    spawn: { ...DEFAULT_SCHEDULE_SPAWN },
    createdBy: 'jonas',
    createdAt: 0,
    updatedAt: 0,
    runCount: 0,
    consecutiveFailures: 0,
    ...over,
  }
}

/** A conversation shaped only where the liveness fold looks: the epic seat's
 *  `cardId`, which is the ONE structured card <-> conversation link there is. */
function conv(id: string, cardId: string): Conversation {
  return { id, launchConfig: { epic: { cardId } } } as unknown as Conversation
}

const OK_SWEEP: BoardRpcResult = {
  ok: true,
  sweep: {
    proposals: [],
    snapshot: 'head:0:0',
    skipped: false,
    selected: [],
    acted: [],
    refused: [],
    reportDate: '2026-08-22',
    reportPath: '.rclaude/project/reports/2026-08-22.md',
    reportWritten: true,
  },
}

const STAMPED_AT = Date.parse('2026-08-22T04:00:00Z')

function harness(opts: { conversations?: Conversation[]; dead?: string[]; result?: BoardRpcResult } = {}) {
  const sent: { project: string; op: unknown }[] = []
  const stamps: { project: string; at: number }[] = []
  const recorded: { project: string; tz: string; date: string; at: number }[] = []
  const dead = new Set(opts.dead ?? [])
  const deps = {
    callBoard: async (project: string, op: never) => {
      sent.push({ project, op })
      return opts.result ?? OK_SWEEP
    },
    getAllConversations: () => opts.conversations ?? [],
    // Stands in for `werkLiveness`, which needs the socket registry. What the
    // sweep consumes is the ANSWER, so the answer is what a test supplies.
    isLive: (c: Conversation) => !dead.has(c.id),
    stampRun: (project: string, at: number) => stamps.push({ project, at }),
    recordReport: (project: string, tz: string, sweep: BoardSweepResult, at: number) =>
      recorded.push({ project, tz, date: sweep.reportDate, at }),
    now: () => STAMPED_AT,
  }
  return { deps, sent, stamps, recorded }
}

describe('the liveness answer, not the registry, crosses the wire', () => {
  test('only cards with a LIVE conversation are named', async () => {
    const { deps, sent } = harness({
      conversations: [conv('c1', 'being-worked'), conv('c2', 'finished')],
      dead: ['c2'],
    })
    await dispatchBoardSweep(makeTask(), deps)

    expect(sent).toHaveLength(1)
    expect(sent[0].op).toMatchObject({ op: 'sweep', sweep: { liveCards: ['being-worked'], tz: 'Europe/Berlin' } })
  })

  test('a card retried after a crash is live on the strength of the RETRY', async () => {
    // Two conversations, same card, the first dead. Folding these with AND
    // instead of OR would let the dead predecessor make the live retry look
    // finished -- and it takes two attempts on one card to reproduce.
    const { deps, sent } = harness({
      conversations: [conv('crashed', 'retried'), conv('live', 'retried')],
      dead: ['crashed'],
    })
    await dispatchBoardSweep(makeTask(), deps)
    expect(sent[0].op).toMatchObject({ sweep: { liveCards: ['retried'] } })
  })

  test('the schedule zone is forwarded -- the container is UTC and must not date the report', async () => {
    const { deps, sent } = harness()
    await dispatchBoardSweep(makeTask({ tz: 'Asia/Bangkok' }), deps)
    expect(sent[0].op).toMatchObject({ sweep: { tz: 'Asia/Bangkok' } })
  })
})

describe('a sweep that did not happen is never reported as one', () => {
  test('an RPC failure is a failed fire, carrying the sentinel reason', async () => {
    const { deps } = harness({ result: { ok: false, error: 'no sentinel connected for this project' } })
    expect(await dispatchBoardSweep(makeTask(), deps)).toMatchObject({
      ok: false,
      error: 'no sentinel connected for this project',
    })
  })

  test('an `ok` with no sweep payload is a failure, not a silent success', async () => {
    // What an older sentinel that does not know the op looks like from here.
    const { deps } = harness({ result: { ok: true } })
    const outcome = await dispatchBoardSweep(makeTask(), deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('sweep')
  })

  test('a real sweep succeeds and launches no conversation', async () => {
    const { deps } = harness()
    expect(await dispatchBoardSweep(makeTask(), deps)).toEqual({ ok: true })
  })
})

describe('the last-run stamp', () => {
  test('a completed pass is stamped against the project', async () => {
    const { deps, stamps } = harness()
    await dispatchBoardSweep(makeTask(), deps)
    expect(stamps).toEqual([{ project: PROJECT, at: STAMPED_AT }])
  })

  test('a failed sweep is NOT stamped -- "last ran never" has to stay visible', async () => {
    const { deps, stamps } = harness({ result: { ok: false, error: 'sentinel timed out (10s)' } })
    await dispatchBoardSweep(makeTask(), deps)
    expect(stamps).toEqual([])
  })
})

/**
 * The surface renders what this records and nothing else, so a report recorded
 * for a sweep that did not happen would be a brew nobody brewed.
 */
describe('recording the brew for the surface', () => {
  test('a completed pass records the report, in the SCHEDULE zone', async () => {
    const { deps, recorded } = harness()
    await dispatchBoardSweep(makeTask({ tz: 'Asia/Bangkok' }), deps)
    expect(recorded).toEqual([{ project: PROJECT, tz: 'Asia/Bangkok', date: '2026-08-22', at: STAMPED_AT }])
  })

  test('a failed sweep records NOTHING -- an absent brew must stay absent', async () => {
    const { deps, recorded } = harness({ result: { ok: false, error: 'sentinel timed out (10s)' } })
    await dispatchBoardSweep(makeTask(), deps)
    expect(recorded).toEqual([])
  })

  test('an `ok` with no payload records nothing either', async () => {
    const { deps, recorded } = harness({ result: { ok: true } })
    await dispatchBoardSweep(makeTask(), deps)
    expect(recorded).toEqual([])
  })
})

/**
 * The opt-in itself belongs to the scanner fabric (`scanner-opt-in.ts`), and is
 * pinned there. What is checked here is that the morning report reads THAT
 * predicate rather than inventing a second flag with a second default -- the id
 * exists in the union, and off-by-default is what an unconfigured project gets.
 */
describe("the opt-in is the fabric's, off by default", () => {
  test('an unconfigured project is off for `morning-report`', () => {
    expect(scannerEnabled(null, 'morning-report')).toBe(false)
    expect(scannerEnabled({}, 'morning-report')).toBe(false)
    expect(scannerEnabled({ scanners: {} }, 'morning-report')).toBe(false)
  })

  test('only an explicit true opts in', () => {
    expect(scannerEnabled({ scanners: { 'morning-report': false } }, 'morning-report')).toBe(false)
    expect(scannerEnabled({ scanners: { 'morning-report': true } }, 'morning-report')).toBe(true)
  })

  test('another scanner being on does not turn this one on', () => {
    expect(scannerEnabled({ scanners: { epics: true } }, 'morning-report')).toBe(false)
  })
})
