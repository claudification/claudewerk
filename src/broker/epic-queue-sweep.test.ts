/**
 * THE QUEUE GATE, THROUGH THE REAL SWEEP.
 *
 * `epic-queue.test.ts` pins the arithmetic and `epic-beat.test.ts` pins what a
 * beat does with a verdict. Neither would notice the failure that actually
 * matters here: that nobody COMPUTES the verdict. The gate is the first thing in
 * this engine that needs a fact about a whole project before any single epic
 * beats, so the wiring -- read every run, decide the queue once, hand each beat
 * its own -- is the part worth a test with two real epics in it.
 *
 * Everything below drives `sweepEpics`, spawns included, and asserts on the
 * SPAWNS. A test that asserted on notes could pass while the engine dispatched.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { EpicCadence } from '../shared/epic-run-types'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { Conversation, EpicResult, EpicRunSnapshot } from '../shared/protocol'
import { configureEpicIo, resetEpicIo } from './epic-io'
import { noteArmedEpic, resetArmedEpics } from './epic-registry'
import { resetSweepGuard, type SweepDeps, sweepEpics } from './epic-sweep-loop'

const PROJECT = 'claude://studio/proj'
const NOW = Date.parse('2026-08-21T12:00:00.000Z')

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

function run(epicId: string, over: Partial<EpicRunSnapshot> = {}): EpicRunSnapshot {
  return { ...RUN, epicId, ...over }
}

function card(slug: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return { slug, status: 'open', title: slug, tags: [], refs: [], created: '', mtime: 1, bodyPreview: '', ...over }
}

/** An epic card plus one ready child -- the smallest board a beat will dispatch
 *  from. */
function epicWithReadyCard(epicId: string): ProjectTaskMeta[] {
  return [card(epicId, { tags: ['epic'] }), card(`${epicId}-c1`, { epic: epicId })]
}

/** A LIVE werk-worker for `epicId`. What "another epic has work in flight" is,
 *  as the conversation registry sees it. */
function liveSeat(epicId: string, cardId: string): Conversation {
  return {
    id: `conv_${epicId}_${cardId}`,
    project: PROJECT,
    status: 'active',
    launchConfig: { epic: { epicId, role: 'werk-worker', cardId, gen: 1 } },
  } as unknown as Conversation
}

let runs: Map<string, EpicRunSnapshot>
let cards: ProjectTaskMeta[]
let convs: Conversation[]
let spawns: string[]
let log: string[]

const deps = (): SweepDeps =>
  ({
    getAllConversations: () => convs,
    isLive: (c: Conversation) => c.status === 'active',
    producedOutput: () => true,
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
    spawnContext: {},
    epicSpendUsd: () => 0,
    log: (line: string) => log.push(line),
    windowOpen: async () => true,
    now: () => NOW,
  }) as unknown as SweepDeps

beforeEach(() => {
  runs = new Map()
  cards = []
  convs = []
  spawns = []
  log = []
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
    sendEpicOp: async () => ({ type: 'epic_result', requestId: 'r', op: 'patch', ok: true }) as EpicResult,
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

/** Arm an epic with a ready card on the board. */
function arm(epicId: string, when: EpicCadence[], over: Partial<EpicRunSnapshot> = {}): void {
  runs.set(epicId, run(epicId, { cadence: when, ...over }))
  cards.push(...epicWithReadyCard(epicId))
  noteArmedEpic(PROJECT, epicId)
}

describe('a queued epic waits for the project, through the sweep', () => {
  test('dispatches nothing while another epic has a live seat, and logs its position', async () => {
    arm('epic-busy', ['now'], { status: 'running', startedAt: '2026-08-21T10:00:00.000Z' })
    arm('epic-queued', ['queue'])
    convs.push(liveSeat('epic-busy', 'epic-busy-c1'))

    await sweepEpics(deps())

    expect(spawns.filter(s => s.startsWith('epic-queued'))).toEqual([])
    expect(log.join('\n')).toContain('queued, position 1 of 1')
    expect(log.join('\n')).toContain('epic-busy')
  })

  test('dispatches on the first sweep after the other epic goes idle', async () => {
    arm('epic-busy', ['now'], { status: 'running', startedAt: '2026-08-21T10:00:00.000Z' })
    arm('epic-queued', ['queue'])
    // Every seat of the other epic has ended: nothing is in flight anywhere.
    convs.push({ ...liveSeat('epic-busy', 'epic-busy-c1'), status: 'ended' } as Conversation)

    await sweepEpics(deps())

    expect(spawns).toContain('epic-queued/epic-queued-c1')
  })

  /**
   * THE HALF THAT MAKES `queue` MEAN ANYTHING. Without it the queued epic takes a
   * runner nobody agreed to give up, and the epic it was armed to avoid
   * colliding with dispatches straight into it on the next beat.
   */
  test('an epic on no queue stops dispatching while a queued one HOLDS the runner', async () => {
    arm('epic-holder', ['queue'], { status: 'running', startedAt: '2026-08-21T11:00:00.000Z' })
    arm('epic-ordinary', ['now'])

    await sweepEpics(deps())

    expect(spawns.filter(s => s.startsWith('epic-ordinary'))).toEqual([])
    expect(log.join('\n')).toContain('epic-holder has the runner exclusively')
  })

  test('the hold ends when the holder parks -- going dry is what releases it', async () => {
    arm('epic-holder', ['queue'], { status: 'paused', startedAt: '2026-08-21T11:00:00.000Z' })
    arm('epic-ordinary', ['now'])

    await sweepEpics(deps())

    expect(spawns).toContain('epic-ordinary/epic-ordinary-c1')
  })

  test('an ordinary project is untouched: no queue anywhere, everything dispatches', async () => {
    arm('epic-a', ['now'])
    arm('epic-b', ['now'])

    await sweepEpics(deps())

    expect(spawns).toContain('epic-a/epic-a-c1')
    expect(spawns).toContain('epic-b/epic-b-c1')
  })
})
