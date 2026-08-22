/**
 * A STOPPED RUN STOPS BEING SWEPT -- the assertion nothing made.
 *
 * `standDown` in `epic-beat-actions.ts` is the shared tail of the three ways a
 * run stops (a plan CHECKPOINT, a park, a complete) and its last effect before
 * the log line is `forgetArmedEpic`, which takes the epic out of the sweep
 * registry. Deleting that call left the ENTIRE suite green -- measured by
 * mutation on `4824f67a` and again on bare `main` at `ca8119c3`, so the gap is
 * inherited rather than something the `standDown` extraction introduced.
 *
 * WHAT THE GAP COSTS: a parked or completed run left registered is beaten every
 * 45 seconds for the life of the broker, burning a sentinel round trip per epic
 * on a run that is over. The symptom is a slow, quiet leak of beats -- nothing
 * throws, nothing fails, and nobody reads a log for it.
 *
 * These tests are written to DIE when that line goes. They are deliberately not
 * folded into `epic-executor.test.ts`: that file asserts what a beat decides,
 * and this one asserts what survives a beat in process-global state, which wants
 * its own `resetArmedEpics` discipline rather than a shared one.
 *
 * THE NEGATIVE CASE IS PART OF THE POINT. `plan-accept` releases the lease and
 * logs through the same `resolvePlanning` function, and it is NOT a `standDown`
 * caller -- that run proceeds to beat 1 and must stay registered. Closing the
 * coverage gap must not arm a rule that kills it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { boardFingerprint } from '../shared/epic-board-fingerprint'
import type { EpicLease } from '../shared/epic-lease'
import { acknowledgedCardIds, dispatchCountsByCard } from '../shared/epic-log'
import type { EpicLogEntry } from '../shared/epic-run-types'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { EpicResult, EpicRunSnapshot } from '../shared/protocol'
import type { TaskStatus } from '../shared/task-statuses'
import { type BeatDeps, runEpicBeat } from './epic-executor'
import { configureEpicIo, resetEpicIo } from './epic-io'
import { resetPromiseMemory } from './epic-promise'
import { isArmed, listArmedEpics, noteArmedEpic, resetArmedEpics } from './epic-registry'
import type { EpicGroup } from './epic-sweep'

const PROJECT = 'claude://studio/proj'
const EPIC = 'e1'

const RUN: EpicRunSnapshot = {
  epicId: EPIC,
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
    epicId: EPIC,
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

let log: string[]
let baton: EpicLogEntry[]
let ops: Array<{ op: string; patch?: unknown }>
let cards: ProjectTaskMeta[]
let run: EpicRunSnapshot
let lease: EpicLease | null

const opKinds = () => ops.map(o => o.op)

const deps = () =>
  ({
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
    spawnContext: {},
    log: (line: string) => log.push(line),
    windowOpen: async () => true,
    now: () => Date.parse('2026-08-22T00:00:00.000Z'),
    epicSpendUsd: () => 0,
  }) as unknown as BeatDeps

beforeEach(() => {
  log = []
  baton = []
  ops = []
  cards = []
  run = { ...RUN }
  lease = { convId: '', gen: 3, at: '' }
  resetPromiseMemory()
  resetArmedEpics()
  // The run is ARMED, which is the precondition every case here is about: there
  // is something for `forgetArmedEpic` to remove, so its absence is observable.
  noteArmedEpic(PROJECT, EPIC)

  configureEpicIo({
    fetchEpicRun: async () => ({
      run,
      baton,
      acknowledgedCardIds: acknowledgedCardIds(baton),
      dispatchCounts: dispatchCountsByCard(baton),
      lease,
    }),
    fetchBoardRead: async () => ({ ok: true, cards }),
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
    dispatchSpawn: mock(async () => ({ ok: true, conversationId: 'conv_1', jobId: 'j' })) as never,
  })
})

afterEach(() => {
  resetEpicIo()
  resetArmedEpics()
})

/**
 * The three `standDown` callers, one describe each. Every one asserts the same
 * three things in the same order -- the run stopped, the lease was released, the
 * epic left the sweep -- because the third is the one that was never asserted
 * and it is only meaningful if the first two say the stand-down actually ran.
 */
describe('a run that PARKS stops being swept', () => {
  /** The second dry generation: nothing ready, nothing in flight, one strike
   *  already banked. This is the commonest way an unattended run stops. */
  const parked = async () => {
    run = { ...RUN, dryGens: 1 }
    cards = [card(EPIC, 'open', { tags: ['epic'] })]
    await runEpicBeat(deps(), group())
  }

  test('the run is patched to `paused` and the lease released', async () => {
    await parked()
    expect(ops.find(o => (o.patch as { status?: string })?.status)?.patch).toMatchObject({ status: 'paused' })
    expect(opKinds()).toContain('release')
  })

  test('and the epic is GONE from the armed set -- not beaten again for the life of the broker', async () => {
    await parked()
    expect(isArmed(PROJECT, EPIC)).toBe(false)
    expect(listArmedEpics()).toEqual([])
  })
})

describe('a run that COMPLETES stops being swept', () => {
  const completed = async () => {
    cards = [card(EPIC, 'open', { tags: ['epic'] }), card('t1', 'done', { epic: EPIC })]
    await runEpicBeat(deps(), group())
  }

  test('the run is patched to `complete` and the lease released', async () => {
    await completed()
    expect(ops.find(o => (o.patch as { status?: string })?.status)?.patch).toMatchObject({ status: 'complete' })
    expect(opKinds()).toContain('release')
  })

  test('and the epic is GONE from the armed set', async () => {
    await completed()
    expect(isArmed(PROJECT, EPIC)).toBe(false)
    expect(listArmedEpics()).toEqual([])
  })
})

/**
 * THE THIRD CALLER, reached through `resolvePlanning` rather than `settleRun`.
 *
 * A planning generation that REWROTE the board checkpoints: nothing dispatches,
 * a human reads the plan, and the run waits to be started again. It is the one
 * stand-down that leaves the run recoverable by a human rather than finished, so
 * a leaked sweep entry here beats an epic that is deliberately sitting still.
 */
describe('a plan CHECKPOINT stops being swept', () => {
  /** `planBaseline` set and DISAGREEING with the current fingerprint is exactly
   *  what `planningBeat` reads as "the werk-planner changed the board". */
  const checkpointed = async () => {
    cards = [card(EPIC, 'open', { tags: ['epic'] }), card('t1', 'open', { epic: EPIC })]
    run = { ...RUN, plan: true, planned: false, planBaseline: 'a-board-that-no-longer-exists' }
    await runEpicBeat(deps(), group())
  }

  test('the run is paused, planning is closed, and the lease released', async () => {
    await checkpointed()
    const patch = ops.find(o => (o.patch as { status?: string })?.status)?.patch
    expect(patch).toMatchObject({ status: 'paused', planned: true, planBaseline: '' })
    expect(opKinds()).toContain('release')
    expect(baton.find(e => e.kind === 'checkpoint')?.body).toContain('CHECKPOINT')
  })

  test('and the epic is GONE from the armed set', async () => {
    await checkpointed()
    expect(isArmed(PROJECT, EPIC)).toBe(false)
    expect(listArmedEpics()).toEqual([])
  })
})

/**
 * THE NEGATIVE CASE. `plan-accept` shares `resolvePlanning` with the checkpoint
 * branch and does three of the same four things -- patch, release, log -- but it
 * is NOT a `standDown` caller, because the run it describes is about to run beat
 * 1. Forgetting it here would strand every planned run at generation 0.
 */
describe('a plan ACCEPT keeps the run armed', () => {
  const accepted = async () => {
    cards = [card(EPIC, 'open', { tags: ['epic'] }), card('t1', 'open', { epic: EPIC })]
    // The baseline the werk-planner recorded IS the board as it stands: unchanged.
    run = { ...RUN, plan: true, planned: false, planBaseline: boardFingerprint(cards, EPIC) }
    await runEpicBeat(deps(), group())
  }

  test('it releases the lease and says the plan was accepted', async () => {
    await accepted()
    expect(opKinds()).toContain('release')
    expect(log.join('\n')).toContain('plan accepted')
  })

  test('it writes NO checkpoint -- this run is not stopping', async () => {
    await accepted()
    expect(baton.filter(e => e.kind === 'checkpoint')).toEqual([])
  })

  test('and the epic is STILL ARMED, because the sweep has to come back for beat 1', async () => {
    await accepted()
    expect(isArmed(PROJECT, EPIC)).toBe(true)
    expect(listArmedEpics()).toEqual([{ project: PROJECT, epicId: EPIC }])
  })
})

/**
 * THE SECOND NEGATIVE CASE, and the sharper one: A LEG'S RE-PLAN TAKES THE
 * CHECKPOINT BRANCH AND MUST NOT STAND DOWN.
 *
 * It reaches `resolvePlanning` through the SAME `plan-checkpoint` action the
 * generation-0 gate does, with the same rewritten board underneath it, and the
 * only thing separating them is `gate` on the action. Get that bit wrong and the
 * failure is silent in the worst direction available here: every leg boundary
 * would pause the run and take the epic out of the sweep, so an unattended epic
 * would stop dead at its first boundary having reported nothing but a checkpoint
 * -- which is exactly the "run goes quiet with nobody told" failure this whole
 * engine keeps having.
 *
 * Jonas chose `auto`: re-plan and continue. These three tests are that choice.
 */
describe('a LEG re-plan notifies and keeps the run armed', () => {
  const replanned = async () => {
    cards = [card(EPIC, 'open', { tags: ['epic'] }), card('t1', 'open', { epic: EPIC })]
    // Leg 2 -- the run is past its first boundary -- with a baseline that no
    // longer matches, which is `planningBeat`'s "the werk-planner changed things".
    run = { ...RUN, plan: true, planned: false, leg: 2, planBaseline: 'a-board-that-no-longer-exists' }
    await runEpicBeat(deps(), group())
  }

  test('planning is closed and the lease released, but the run is NOT paused', async () => {
    await replanned()
    expect(ops.some(o => (o.patch as { status?: string })?.status === 'paused')).toBe(false)
    expect(ops.some(o => (o.patch as { planned?: boolean })?.planned === true)).toBe(true)
    expect(opKinds()).toContain('release')
  })

  /** A `leg` entry, NOT a `checkpoint`. A checkpoint means "we are waiting for
   *  you", and filing a boundary under it makes every leg look like a park. */
  test('it files a `leg` entry naming the board changes, and no checkpoint', async () => {
    await replanned()
    expect(baton.filter(e => e.kind === 'checkpoint')).toEqual([])
    const entry = baton.find(e => e.kind === 'leg')
    expect(entry?.body).toContain('leg 2 starts here')
    expect(entry?.body).toContain('t1: NEW')
  })

  test('and the epic is STILL ARMED -- the run carries straight on into the leg', async () => {
    await replanned()
    expect(isArmed(PROJECT, EPIC)).toBe(true)
    expect(listArmedEpics()).toEqual([{ project: PROJECT, epicId: EPIC }])
  })
})

/**
 * THE BOUNDARY ITSELF, end to end through the executor: the scalars land on disk
 * and the notification lands in the baton.
 *
 * Here rather than in `epic-legs-beat.test.ts` because that file asserts the pure
 * DECISION and this asserts that the decision is actually performed -- which is
 * the seam a `PERFORMERS` table entry can be missing from without anything failing
 * to compile (the map is cast).
 */
describe('a leg boundary is written down', () => {
  const ended = async () => {
    cards = [card(EPIC, 'open', { tags: ['epic'] }), card('t1', 'open', { epic: EPIC })]
    // Legs armed, planning done, and the ledger already past the budget with
    // nothing in flight: the drained soft stop.
    run = { ...RUN, plan: true, planned: true, legBudgetUsd: 200, legStartUsd: 0, spentUsd: 240, maxUsd: 0 }
    await runEpicBeat(deps(), group())
  }

  test('the patch rolls the leg, moves the watermark and re-owes a plan', async () => {
    await ended()
    const patch = ops.find(o => (o.patch as { leg?: number })?.leg !== undefined)?.patch
    expect(patch).toMatchObject({ leg: 2, legStartUsd: 240, planned: false })
  })

  test('and the baton says what the leg cost and why it ended', async () => {
    await ended()
    const entry = baton.find(e => e.kind === 'leg')
    expect(entry?.body).toContain('LEG 1 ENDED -- $240.00 of a $200.00 leg budget')
    expect(entry?.body).toContain('the leg budget was spent')
    expect(entry?.body).toContain('does NOT wait for a human')
  })

  test('the run stays armed and is NOT paused -- a boundary is not a stop', async () => {
    await ended()
    expect(ops.some(o => (o.patch as { status?: string })?.status === 'paused')).toBe(false)
    expect(isArmed(PROJECT, EPIC)).toBe(true)
  })
})
