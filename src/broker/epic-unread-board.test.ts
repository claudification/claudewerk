/**
 * A BEAT OVER A BOARD IT NEVER READ.
 *
 * `epic-inspect.test.ts` pins the RENDERING half of this failure -- a timed-out
 * `list` that came back as `cards: []` made an inspect announce "no epic on the
 * board" about an epic with 31 children on disk. This pins the DECISION half,
 * which is the expensive one: the executor consumed the same collapsed read and
 * planned against it.
 *
 * What that cost, before the gate below existed, with the board read failing and
 * nothing else wrong:
 *
 *   - `orphanedCardIds` returned EVERY live seat, so the beat warned about every
 *     card in the run,
 *   - `unacknowledgedCards` acknowledged settles into the baton against a lane
 *     map read off no board at all,
 *   - `planEpic` found no epic, which is a DRY generation -- so the beat woke and
 *     BILLED a fresh werk-master to replan a board nobody had read,
 *   - and on the second consecutive dry generation it PARKED the run, with an
 *     idle reason ("no epic `e1` on the board") that was a statement about a
 *     `list` that never returned.
 *
 * A beat that skips a tick because the sentinel was unreachable is free. Every
 * test here is that difference.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { EpicLease } from '../shared/epic-lease'
import { acknowledgedCardIds, dispatchCountsByCard } from '../shared/epic-log'
import type { EpicLogEntry } from '../shared/epic-run-types'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { EpicResult, EpicRunSnapshot } from '../shared/protocol'
import type { TaskStatus } from '../shared/task-statuses'
import { recentBeats, resetBeatLog } from './epic-beat-log'
import type { EpicBoardRead } from './epic-broker-rpc'
import { type BeatDeps, runEpicBeat } from './epic-executor'
import { configureEpicIo, resetEpicIo } from './epic-io'
import { resetPromiseMemory } from './epic-promise'
import { noteArmedEpic, resetArmedEpics } from './epic-registry'
import type { EpicGroup } from './epic-sweep'

const PROJECT = 'claude://studio/proj'
const NOW = Date.parse('2026-08-22T09:00:00.000Z')

const RUN: EpicRunSnapshot = {
  epicId: 'e1',
  project: PROJECT,
  cadence: ['now'],
  status: 'running',
  gen: 3,
  target: 'merged',
  dryGens: 0,
  unlandedWoken: '',
  maxGens: 40,
  maxUsd: 100,
  maxWallClockMinutes: 480,
  spentUsd: 0,
  legBudgetUsd: 0,
  legStartUsd: 0,
  leg: 1,
  concurrency: 3,
  plan: false,
  planned: true,
  created: '',
  updated: '',
  digest: '',
}

function card(slug: string, status: TaskStatus, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return { slug, status, title: slug, tags: [], refs: [], created: '', mtime: 1, bodyPreview: '', ...over }
}

function group(over: Partial<EpicGroup> = {}): EpicGroup {
  return {
    epicId: 'e1',
    project: PROJECT,
    inFlight: [],
    inVerify: [],
    werkMasterAlive: false,
    liveWerkMasters: [],
    abandonedWerkMasters: [],
    settled: [],
    failedLegs: [],
    abandonedSeats: [],
    unspawnable: [],
    convIds: [],
    maxGenSeen: 3,
    ...over,
  }
}

/** The board this epic actually has -- three children, one of them dispatchable.
 *  Every test below runs against THIS board, read or unread, so the difference
 *  between the two answers is the only variable. */
const BOARD: ProjectTaskMeta[] = [
  card('e1', 'in-progress', { tags: ['epic'] }),
  card('c-ready', 'open', { epic: 'e1' }),
  card('c-done', 'done', { epic: 'e1' }),
]

let log: string[]
let baton: EpicLogEntry[]
let ops: Array<{ op: string; patch?: unknown }>
let spawns: Array<{ name: string; epic: Record<string, unknown> }>
let board: EpicBoardRead
let run: EpicRunSnapshot
let lease: EpicLease | null

const patchOps = () => ops.filter(o => o.op === 'patch').map(o => o.patch as Record<string, unknown>)

const deps = () =>
  ({
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
    spawnContext: {},
    log: (line: string) => log.push(line),
    windowOpen: async () => true,
    now: () => NOW,
    epicSpendUsd: () => 0,
  }) as unknown as BeatDeps

beforeEach(() => {
  log = []
  baton = []
  ops = []
  spawns = []
  board = { ok: true, cards: BOARD }
  run = { ...RUN }
  lease = { convId: '', gen: 3, at: '' }
  resetPromiseMemory()
  resetBeatLog()
  noteArmedEpic(PROJECT, 'e1')

  configureEpicIo({
    fetchEpicRun: async () => ({
      run,
      baton,
      acknowledgedCardIds: acknowledgedCardIds(baton),
      dispatchCounts: dispatchCountsByCard(baton),
      lease,
    }),
    fetchBoardRead: async () => board,
    appendBaton: async (_d, _p, _e, entry) => {
      baton.push({
        ts: '',
        kind: entry.kind,
        convId: entry.convId,
        ...(entry.cardId ? { cardId: entry.cardId } : {}),
        body: entry.body,
      })
      return { type: 'epic_result', requestId: 'r', op: 'log_append', ok: true } as EpicResult
    },
    sendEpicOp: async (_d, _p, op) => {
      ops.push({ op: op.op, patch: op.patch })
      if (op.op === 'lease') {
        return {
          type: 'epic_result',
          requestId: 'r',
          op: 'lease',
          ok: true,
          lease: { granted: true, convId: 'conv_werk_master', gen: (op.lease?.expectGen ?? 0) + 1, at: '' },
        } as EpicResult
      }
      return { type: 'epic_result', requestId: 'r', op: op.op, ok: true } as EpicResult
    },
    dispatchSpawn: mock(async (req: { name: string; epic: Record<string, unknown> }) => {
      spawns.push({ name: req.name, epic: req.epic })
      return { ok: true, conversationId: `conv_${spawns.length}`, jobId: 'j' }
    }) as never,
  })
})

afterEach(() => {
  resetEpicIo()
  resetArmedEpics()
  resetBeatLog()
})

const unread = () => {
  board = { ok: false, cards: [], error: 'sentinel timed out after 15s' }
}

describe('a beat whose board read FAILED', () => {
  test('dispatches nothing, acknowledges nothing and completes nothing', async () => {
    unread()
    const out = await runEpicBeat(deps(), group({ settled: ['c-done'] }))

    expect(out.actions).toBe(0)
    expect(spawns).toEqual([])
    // Not one entry: no acknowledgement of `c-done`, whose lane this beat could
    // not read, and no wake of a werk-master to replan a board nobody saw.
    expect(baton.filter(e => e.kind === 'completion')).toEqual([])
    // No lifecycle write at all -- not the spend ledger, not `dryGens`, not the
    // status. The run must look untouched by a tick that learned nothing.
    expect(patchOps()).toEqual([])
    expect(ops.filter(o => o.op === 'lease')).toEqual([])
  })

  /**
   * THE DANGEROUS ONE. An unread board is an empty plan, an empty plan is a dry
   * generation, and a run one dry generation in parks on the next. That is a
   * live run ended by a sentinel timeout.
   */
  test('does not park the run on what would have been the second dry generation', async () => {
    run = { ...RUN, dryGens: 1 }
    unread()
    const out = await runEpicBeat(deps(), group())

    expect(patchOps().find(p => p.status !== undefined)).toBeUndefined()
    expect(out.note).not.toContain('dry generation')
  })

  test('warns about no orphaned seats -- every live seat looks orphaned on an empty board', async () => {
    unread()
    await runEpicBeat(deps(), group({ inFlight: ['c-ready'], convIds: ['conv_a'] }))
    expect(log.filter(l => l.includes('orphan'))).toEqual([])
  })

  /** The skip has to be VISIBLE, or a run that quietly does nothing for an hour
   *  looks exactly like a healthy idle sweep -- the failure `epic-beat-log.ts`
   *  exists for. */
  test('names the board read in the note, the broker log and the beat log', async () => {
    unread()
    const out = await runEpicBeat(deps(), group())

    expect(out.note).toContain('board')
    expect(out.note).toContain('sentinel timed out after 15s')
    expect(out.error).toBe('sentinel timed out after 15s')
    expect(log.some(l => l.includes('board') && l.includes('sentinel timed out after 15s'))).toBe(true)

    const recorded = recentBeats(PROJECT, 'e1', 1)[0]
    expect(recorded?.note).toContain('board')
    expect(recorded?.boardUnread).toBe(true)
  })

  /**
   * ONE BATON ENTRY PER OUTAGE, not one per tick. The baton is the werk-master's
   * whole memory and its prompt tail is twenty entries deep, so a sentinel down
   * for fifteen minutes would otherwise push every real fact out of the file a
   * fresh generation reads.
   */
  test('files ONE baton entry for a streak of failed reads, not one per beat', async () => {
    unread()
    await runEpicBeat(deps(), group())
    await runEpicBeat(deps(), group())
    await runEpicBeat(deps(), group())

    const filed = baton.filter(e => e.kind === 'board-unread')
    expect(filed).toHaveLength(1)
    expect(filed[0]?.body).toContain('sentinel timed out after 15s')
  })

  test('files a fresh entry once the board comes back and fails again', async () => {
    unread()
    await runEpicBeat(deps(), group())
    board = { ok: true, cards: BOARD }
    await runEpicBeat(deps(), group())
    unread()
    await runEpicBeat(deps(), group())

    expect(baton.filter(e => e.kind === 'board-unread')).toHaveLength(2)
  })
})

/** The control, and it has to name the CARD. A beat over an unread board also
 *  "spawns something" -- a werk-master, to replan the nothing it found -- so an
 *  assertion that only counts spawns passes for both answers. */
test('a beat whose board read succeeded dispatches the ready card', async () => {
  const out = await runEpicBeat(deps(), group())

  expect(out.actions).toBeGreaterThan(0)
  expect(spawns.map(s => s.epic.cardId)).toContain('c-ready')
  expect(baton.filter(e => e.kind === 'board-unread')).toEqual([])
})
