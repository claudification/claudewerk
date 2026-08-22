/**
 * THE APPOINTMENT GATE, THROUGH THE REAL SWEEP.
 *
 * `epic-when.test.ts` pins the codec and `epic-beat.test.ts` pins what a beat
 * does with an appointment. Neither would notice the failure that actually costs
 * something: that the gate is never consulted on the path the engine really runs,
 * or that the wall-clock ledger writes anyway while the run is waiting.
 *
 * Everything below drives `sweepEpics` / `beatOneEpic` with a real run and a real
 * board, and asserts on SPAWNS and on the RUN PATCHES that reach the sentinel. A
 * test that asserted on beat notes could pass while the engine dispatched.
 *
 * The differential pairs are the design: every case that expects nothing has a
 * twin one clock-tick later that expects a dispatch, so none of them can pass
 * because the harness simply never dispatches anything.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { EpicCadence } from '../shared/epic-run-types'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { Conversation, EpicResult, EpicRunSnapshot } from '../shared/protocol'
import { configureEpicIo, resetEpicIo } from './epic-io'
import { noteArmedEpic, resetArmedEpics } from './epic-registry'
import { beatOneEpic, resetSweepGuard, type SweepDeps, sweepEpics } from './epic-sweep-loop'

const PROJECT = 'claude://studio/proj'

/** 2026-08-22T02:00:00+07:00 -- the appointment every case below is armed for. */
const AT_2AM: EpicCadence = 'at:2026-08-22T02:00:00+07:00'
const FIRES_AT = Date.parse('2026-08-21T19:00:00.000Z')
/** Four hours before it fires. */
const EARLY = FIRES_AT - 4 * 3_600_000

const RUN: EpicRunSnapshot = {
  epicId: '',
  project: PROJECT,
  cadence: ['now'],
  status: 'armed',
  gen: 1,
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
  created: '2026-08-21T09:00:00.000Z',
  updated: '2026-08-21T09:00:00.000Z',
  digest: '',
}

function card(slug: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return { slug, status: 'open', title: slug, tags: [], refs: [], created: '', mtime: 1, bodyPreview: '', ...over }
}

let runs: Map<string, EpicRunSnapshot>
let cards: ProjectTaskMeta[]
let spawns: string[]
let patches: Array<Record<string, unknown>>
let log: string[]
let nowMs: number
let windowIsOpen: boolean

const deps = (): SweepDeps =>
  ({
    getAllConversations: () => [] as Conversation[],
    isLive: () => false,
    producedOutput: () => true,
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
    spawnContext: {},
    epicSpendUsd: () => 0,
    log: (line: string) => log.push(line),
    windowOpen: async () => windowIsOpen,
    now: () => nowMs,
  }) as unknown as SweepDeps

beforeEach(() => {
  runs = new Map()
  cards = []
  spawns = []
  patches = []
  log = []
  nowMs = EARLY
  windowIsOpen = true
  resetSweepGuard()
  resetArmedEpics()
  configureEpicIo({
    fetchEpicRun: async (_d, _p, epicId) => ({
      run: runs.get(epicId) ?? null,
      baton: [],
      acknowledgedCardIds: [],
      dispatchCounts: {},
      lease: null,
    }),
    fetchBoardRead: async () => ({ ok: true, cards }),
    appendBaton: async () => ({ type: 'epic_result', requestId: 'r', op: 'log_append', ok: true }) as EpicResult,
    sendEpicOp: async (_d, _p, op) => {
      if (op.op === 'patch' && op.patch) patches.push({ ...op.patch })
      return { type: 'epic_result', requestId: 'r', op: 'patch', ok: true } as EpicResult
    },
    dispatchSpawn: mock(async (req: { epic: { cardId?: string; epicId: string } }) => {
      spawns.push(`${req.epic.epicId}/${req.epic.cardId ?? 'werk-master'}`)
      return { ok: true, conversationId: `conv_${spawns.length}`, jobId: 'j' }
    }) as never,
  })
})

afterEach(() => {
  resetEpicIo()
  resetSweepGuard()
  resetArmedEpics()
})

/** Arm an epic with one ready child -- the smallest board a beat dispatches from. */
function arm(epicId: string, when: EpicCadence[], over: Partial<EpicRunSnapshot> = {}): void {
  runs.set(epicId, { ...RUN, epicId, cadence: when, ...over })
  cards.push(card(epicId, { tags: ['epic'] }), card(`${epicId}-c1`, { epic: epicId }))
  noteArmedEpic(PROJECT, epicId)
}

describe('an armed run waits for its appointment, through the sweep', () => {
  test('dispatches nothing while the appointment is ahead, and logs the countdown', async () => {
    arm('epic-later', [AT_2AM])

    await sweepEpics(deps())

    expect(spawns).toEqual([])
    expect(log.join('\n')).toContain('waiting until 2026-08-22T02:00:00+07:00')
    expect(log.join('\n')).toContain('in 4 hours')
  })

  test('dispatches on the first sweep after it passes', async () => {
    arm('epic-later', [AT_2AM])
    nowMs = FIRES_AT

    await sweepEpics(deps())

    expect(spawns).toEqual(['epic-later/epic-later-c1'])
  })

  /**
   * THE WALL CLOCK, THROUGH THE REAL WRITE PATH. `epic-beat.test.ts` asserts the
   * PATCH the decision wants; this asserts that nothing else on the way to the
   * sentinel puts a `startedAt` on a run that has only ever waited. A run that
   * started its clock at arming would park on `maxWallClockMinutes` before it had
   * dispatched a single card -- the exact silent bug this card was told to check
   * rather than assume.
   */
  test('never stamps startedAt while it waits, so the wall-clock ceiling cannot trip', async () => {
    arm('epic-later', [AT_2AM], { maxWallClockMinutes: 1 })

    await sweepEpics(deps())

    expect(patches.some(p => 'startedAt' in p)).toBe(false)
    expect(spawns).toEqual([])
    expect(log.join('\n')).not.toContain('wall clock ceiling')
  })

  test('stamps it on the beat the appointment lets through', async () => {
    arm('epic-later', [AT_2AM])
    nowMs = FIRES_AT

    await sweepEpics(deps())

    expect(patches.some(p => p.startedAt === new Date(FIRES_AT).toISOString())).toBe(true)
  })

  test('an appointment composes with the window rather than replacing it', async () => {
    arm('epic-later', ['window', AT_2AM])
    nowMs = FIRES_AT
    windowIsOpen = false

    await sweepEpics(deps())

    expect(spawns).toEqual([])
    expect(log.join('\n')).toContain('window is closed')

    windowIsOpen = true
    await sweepEpics(deps())
    expect(spawns).toEqual(['epic-later/epic-later-c1'])
  })
})

describe('BEAT NOW and the appointment', () => {
  test('fires it early, and says in the log that it overrode the gate', async () => {
    arm('epic-later', [AT_2AM])

    const res = await beatOneEpic(deps(), PROJECT, 'epic-later')

    expect(res.ok).toBe(true)
    expect(spawns).toEqual(['epic-later/epic-later-c1'])
    expect(log.join('\n')).toContain('OVERRIDDEN by an explicit beat')
  })

  /** THE DIFFERENTIAL THAT MATTERS. If the forced beat simply skipped the whole
   *  `when` axis, this would dispatch too -- and `window` is a project policy no
   *  single button gets to revoke. */
  test('does NOT fire a closed window, on the very same path', async () => {
    arm('epic-night', ['window'])
    windowIsOpen = false

    const res = await beatOneEpic(deps(), PROJECT, 'epic-night')

    expect(res.ok).toBe(true)
    expect(spawns).toEqual([])
    expect(log.join('\n')).toContain('window is closed')
  })

  test('the SWEEP on the same run at the same instant still waits', async () => {
    arm('epic-later', [AT_2AM])

    await sweepEpics(deps())

    expect(spawns).toEqual([])
    expect(log.join('\n')).not.toContain('OVERRIDDEN')
  })
})
