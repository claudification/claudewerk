import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleEpicOp } from '../sentinel/epic-handlers'
import type { CommitRow } from '../shared/commit-ledger'
import { acknowledgedCardIds, dispatchCountsByCard, readEpicLog } from '../shared/epic-log'
import { SEAT_ATTACH_GRACE_MS } from '../shared/epic-pending-seats'
import { MAX_CARD_SEATS } from '../shared/epic-ready'
import type { EpicLogEntry } from '../shared/epic-run-types'
import { cardPath } from '../shared/project-paths'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import { parsePromiseBlock } from '../shared/promise-ledger'
import type { EpicBatonQuery, EpicResult, EpicRunSnapshot } from '../shared/protocol'
import type { TaskStatus } from '../shared/task-statuses'
import { toEpicRunView } from './epic-broker-rpc'
import { type BeatDeps, runEpicBeat } from './epic-executor'
import { configureEpicIo, epicIo, resetEpicIo } from './epic-io'
import { resetPromiseMemory } from './epic-promise'
import { noteArmedEpic, resetArmedEpics } from './epic-registry'
import type { EpicGroup } from './epic-sweep'

const PROJECT = 'claude://studio/proj'

const RUN: EpicRunSnapshot = {
  epicId: 'e1',
  project: PROJECT,
  cadence: ['now'],
  status: 'running',
  gen: 3,
  target: 'merged',
  dryGens: 0,
  maxGens: 40,
  maxUsd: 100,
  maxWallClockMinutes: 480,
  spentUsd: 0,
  concurrency: 3,
  plan: false,
  planned: true,
  created: '',
  updated: '',
  digest: '',
}

function card(slug: string, status: TaskStatus, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    status,
    title: slug,
    tags: [],
    refs: [],
    created: '',
    mtime: 1,
    bodyPreview: '',
    ...over,
  }
}

function group(over: Partial<EpicGroup> = {}): EpicGroup {
  return {
    epicId: 'e1',
    project: PROJECT,
    inFlight: [],
    inVerify: [],
    overseerAlive: false,
    liveOverseers: [],
    settled: [],
    failedLegs: [],
    abandonedSeats: [],
    unspawnable: [],
    convIds: [],
    maxGenSeen: 3,
    ...over,
  }
}

/** Every effect the executor can have, recorded. */
let log: string[]
let baton: EpicLogEntry[]
let ops: Array<{
  op: string
  patch?: unknown
  lease?: { convId: string; expectGen: number; holderAlive?: boolean; adopt?: boolean }
}>
let spawns: Array<{ name: string; epic: Record<string, unknown> }>
let leaseGranted: boolean
let cards: ProjectTaskMeta[]
let run: EpicRunSnapshot | null
/** What the cost store would answer for this run's conversations. */
let spendUsd: number
/** The conversation ids the spend fold was actually asked about. */
let spendAskedFor: readonly string[]
let nowMs: number

const NOW_0 = Date.parse('2026-08-21T00:00:00.000Z')

/** Every `patch` op the beat sent, in order. */
const patchOps = () => ops.filter(o => o.op === 'patch').map(o => o.patch as Record<string, unknown>)

/** The patch that moved the run's LIFECYCLE, as opposed to its ledger. A beat
 *  now writes what it spent before it acts, so "the first patch" is no longer
 *  the same question as "the patch that parked it". */
const statusPatch = () => patchOps().find(p => p.status !== undefined)

const deps = () =>
  ({
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
    spawnContext: {},
    log: (line: string) => log.push(line),
    windowOpen: async () => true,
    now: () => nowMs,
    epicSpendUsd: (ids: readonly string[]) => {
      spendAskedFor = ids
      return spendUsd
    },
  }) as unknown as BeatDeps

beforeEach(() => {
  log = []
  baton = []
  ops = []
  spawns = []
  leaseGranted = true
  cards = []
  run = { ...RUN }
  spendUsd = 0
  spendAskedFor = []
  nowMs = NOW_0
  // The promise ledger's once-per-card memory is process-global by design (one
  // broker, one ledger). Without this, the second test to beat over the same
  // card silently records nothing.
  resetPromiseMemory()

  configureEpicIo({
    // `baton` here is the WHOLE log, so folding it is the honest answer. The
    // seam tests below are the ones that exercise a truncated tail.
    fetchEpicRun: async () => ({
      run,
      baton,
      acknowledgedCardIds: acknowledgedCardIds(baton),
      dispatchCounts: dispatchCountsByCard(baton),
      lease: null,
      ...(run ? {} : { error: 'no run' }),
    }),
    fetchBoardCards: async () => cards,
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
      ops.push({ op: op.op, patch: op.patch, lease: op.lease })
      if (op.op === 'lease') {
        return {
          type: 'epic_result',
          requestId: 'r',
          op: 'lease',
          ok: true,
          lease: leaseGranted
            ? { granted: true, convId: 'conv_overseer', gen: (op.lease?.expectGen ?? 0) + 1, at: '' }
            : { granted: false, convId: 'conv_other', gen: 9, at: '', reason: 'stale wake' },
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
})

describe('runEpicBeat', () => {
  test('an epic with no run artifact does nothing and says so', async () => {
    run = null
    const out = await runEpicBeat(deps(), group())
    expect(out.actions).toBe(0)
    expect(out.note).toContain('no run artifact')
    expect(spawns).toHaveLength(0)
  })

  /**
   * 2026-08-20, from the wall: `epic-the-wall` had been PAUSED for hours and its
   * three newest baton entries were twenty seconds old. `guardBeat` refuses to
   * ACT on a terminal run, but it is consulted after the acknowledgement pass --
   * and acknowledgement is a write.
   */
  test.each(['paused', 'complete', 'aborted'] as const)('a %s run is not written to at all', async status => {
    run = { ...RUN, status }
    const out = await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(baton).toHaveLength(0)
    expect(ops).toHaveLength(0)
    expect(spawns).toHaveLength(0)
    expect(out.note).toContain(`run is ${status}`)
  })

  test('a settled card is ACKNOWLEDGED into the baton before anything else', async () => {
    const out = await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(baton[0]).toMatchObject({ kind: 'completion', cardId: 't1', convId: 'broker' })
    expect(out.spawned).toHaveLength(1) // and the overseer was woken for it
  })

  test('the acknowledgement is machine-authored, never an agent narrative', async () => {
    await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(baton[0].convId).toBe('broker')
    expect(baton[0].body).toContain('settled')
  })

  test('an already-acknowledged settle is not written twice', async () => {
    baton = [{ ts: '', kind: 'completion', convId: 'broker', cardId: 't1', body: 'seen' }]
    await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(baton.filter(e => e.kind === 'completion')).toHaveLength(1)
  })

  test('waking takes the lease with the CURRENT generation', async () => {
    await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(ops.some(o => o.op === 'lease')).toBe(true)
    expect(spawns[0].epic).toMatchObject({ role: 'overseer', gen: 4 })
  })

  /**
   * The wake takes the lease before it can know its conversation id, so it takes
   * it under a `pending-` placeholder. Live incident 2026-08-19: the swap to the
   * real id was never written, so the board named a holder nothing could resolve
   * -- the panel showed "lease null . never woken" while five generations ran.
   */
  test('waking ADOPTS the lease under the real conversation id, same generation', async () => {
    await runEpicBeat(deps(), group({ settled: ['t1'] }))
    const leases = ops.filter(o => o.op === 'lease')
    expect(leases[0]?.lease?.convId).toStartWith('pending-')
    const adopt = leases.find(o => o.lease?.adopt)
    expect(adopt?.lease?.convId).toBe('conv_1')
    // Same generation as the wake -- adoption is bookkeeping, not a second wake.
    expect(adopt?.lease?.expectGen).toBe(4)
  })

  /**
   * `overseerAlive` says SOME overseer lives, which reads true in exactly the
   * case the CAS exists to refuse -- a second overseer already running beside a
   * stale holder. The CAS asks about THE HOLDER named on the board.
   *
   * NOTE ON REACH: `planBeat` holds the whole beat on the group-wide
   * `overseerAlive` before the CAS is consulted, so today only the false case is
   * reachable from here. That gate is the one that should become holder-specific
   * too; until it does, this pins the input so the CAS cannot silently go back
   * to answering the group-wide question.
   */
  test('the CAS is told about THE HOLDER named on the board, not about any overseer', async () => {
    configureEpicIo({
      fetchEpicRun: async () => ({
        run,
        baton,
        acknowledgedCardIds: acknowledgedCardIds(baton),
        dispatchCounts: dispatchCountsByCard(baton),
        lease: { convId: 'conv_holder', gen: 4, at: '' },
      }),
    })
    await runEpicBeat(deps(), group({ settled: ['t1'], liveOverseers: ['conv_someone_else'] }))
    expect(ops.find(o => o.op === 'lease')?.lease?.holderAlive).toBe(false)
  })

  test('with no holder on the board it falls back to the conservative group-wide answer', async () => {
    await runEpicBeat(deps(), group({ settled: ['t1'], overseerAlive: false, liveOverseers: [] }))
    expect(ops.find(o => o.op === 'lease')?.lease?.holderAlive).toBe(false)
  })

  test('a spawn that never happened leaves the placeholder alone rather than adopting nothing', async () => {
    configureEpicIo({ dispatchSpawn: (async () => ({ ok: false, error: 'name in use' })) as never })
    await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(ops.filter(o => o.lease?.adopt)).toHaveLength(0)
  })

  /**
   * THE 2026-08-20 DEADLOCK, in one test.
   *
   * `epic-the-wall-ii` beat every 45s for hours with `0 spawned`, logging
   * `wake refused: stale wake: expected gen 12, epic is at gen 11`. The run file
   * said gen 12; the lease on the card said 11. The wake quoted the RUN, the CAS
   * compares against the CARD, and the two could never agree again -- so every
   * settle woke nobody, forever, while the panel said RUNNING.
   *
   * The run file's `gen` is a MIRROR (the sentinel writes it when a lease is
   * granted) and the mirror is hand-editable: an overseer rewriting `run.md`'s
   * digest can rewrite its frontmatter with it. The lease is the only authority,
   * so the wake must quote the lease it just read.
   */
  test('a run whose gen drifted ahead of the lease still wakes -- the CAS quotes the LEASE', async () => {
    run = { ...RUN, gen: 12 }
    configureEpicIo({
      fetchEpicRun: async () => ({
        run,
        baton,
        acknowledgedCardIds: acknowledgedCardIds(baton),
        dispatchCounts: dispatchCountsByCard(baton),
        lease: { convId: 'conv_dead', gen: 11, at: '' },
      }),
    })
    const out = await runEpicBeat(deps(), group({ settled: ['t1'], maxGenSeen: 12 }))
    expect(ops.find(o => o.op === 'lease')?.lease?.expectGen).toBe(11)
    expect(out.spawned).toHaveLength(1)
  })

  test('the drift between the run mirror and the lease is LOGGED, not silently absorbed', async () => {
    run = { ...RUN, gen: 12 }
    configureEpicIo({
      fetchEpicRun: async () => ({
        run,
        baton,
        acknowledgedCardIds: acknowledgedCardIds(baton),
        dispatchCounts: dispatchCountsByCard(baton),
        lease: { convId: 'conv_dead', gen: 11, at: '' },
      }),
    })
    await runEpicBeat(deps(), group({ settled: ['t1'], maxGenSeen: 12 }))
    expect(log.join('\n')).toContain('generation DRIFT')
  })

  test('with the run and the lease in agreement the wake quotes that generation unchanged', async () => {
    configureEpicIo({
      fetchEpicRun: async () => ({
        run,
        baton,
        acknowledgedCardIds: acknowledgedCardIds(baton),
        dispatchCounts: dispatchCountsByCard(baton),
        lease: { convId: 'conv_dead', gen: 3, at: '' },
      }),
    })
    await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(ops.find(o => o.op === 'lease')?.lease?.expectGen).toBe(3)
    expect(log.join('\n')).not.toContain('generation DRIFT')
  })

  /**
   * A STRANDED RUN SAYS SO IN THE BROKER LOG, EVERY BEAT.
   *
   * The armed set is durable now, but the ways in are not all closed: a run
   * armed by an older broker, or a project whose `epics` box was unticked
   * mid-run, still reaches a beat with nothing in the registry. In that state
   * the ONLY reason the beat is happening is a live conversation, and the run
   * dies silently the moment the last seat exits (`epic-the-wall`, 2026-08-19).
   * `runVitality` already diagnosed it in the panel; nobody who was not looking
   * at the panel could find out.
   */
  describe('a run the armed set has lost', () => {
    afterEach(() => resetArmedEpics())

    test('is called STRANDED in the log, with the verb that fixes it', async () => {
      await runEpicBeat(deps(), group())
      expect(log.join('\n')).toContain('STRANDED')
      expect(log.join('\n')).toContain('epic_run action=start')
    })

    test('and an ARMED run gets no such line', async () => {
      noteArmedEpic(PROJECT, 'e1')
      await runEpicBeat(deps(), group())
      expect(log.join('\n')).not.toContain('STRANDED')
    })

    test('matched by project IDENTITY -- a differently-spelled arm still counts as armed', async () => {
      noteArmedEpic('claude://studio/proj/', 'e1')
      await runEpicBeat(deps(), group())
      expect(log.join('\n')).not.toContain('STRANDED')
    })

    test.each(['paused', 'complete', 'aborted'] as const)('a %s run is not stranded, it is over', async status => {
      run = { ...RUN, status }
      await runEpicBeat(deps(), group())
      expect(log.join('\n')).not.toContain('STRANDED')
    })
  })

  test('a REFUSED lease spawns nothing and is logged as normal, not as an error', async () => {
    leaseGranted = false
    const out = await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(out.spawned).toHaveLength(0)
    expect(log.join('\n')).toContain('wake refused')
    expect(log.join('\n')).not.toContain('FAILED')
  })

  test('ready cards dispatch implementers, each recorded in the baton', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'open', { epic: 'e1' })]
    const out = await runEpicBeat(deps(), group())
    expect(out.spawned).toHaveLength(1)
    expect(spawns[0].epic).toMatchObject({ role: 'implementer', cardId: 't1' })
    expect(baton.some(e => e.kind === 'dispatch' && e.cardId === 't1')).toBe(true)
  })

  /**
   * THE REGISTRY-LAG WINDOW, and the reason this whole file's harness stamps
   * `ts: ''` on the entries it writes: a seat dispatched on beat N does not
   * appear in `EpicGroup.inFlight` on beat N+1, because the group is folded from
   * the conversation registry and a spawned conversation carries no epic tag
   * until its agent host connects. Live 2026-08-21 that sent a second
   * implementer into the SAME worktree as a live one -- one working directory,
   * two writers, and whichever committed last buried the other's half.
   */
  test('a card whose seat was just dispatched is NOT dispatched again while the registry is behind', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'open', { epic: 'e1' })]
    baton = [
      {
        ts: new Date(nowMs - 30_000).toISOString(),
        kind: 'dispatch',
        convId: 'conv_just_spawned',
        cardId: 't1',
        body: 'Implementer dispatched for `t1` at generation 3.',
      },
    ]
    // The registry has NOT caught up: `conv_just_spawned` is in no lane at all.
    await runEpicBeat(deps(), group())
    expect(spawns).toHaveLength(0)
  })

  test('and the SAME hold protects the verifier lane, which is how the pair on 2026-08-21 happened', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'in-review', { epic: 'e1' })]
    baton = [
      {
        ts: new Date(nowMs - 11_000).toISOString(),
        kind: 'dispatch',
        convId: 'conv_verifier_arriving',
        cardId: 't1',
        body: 'Verifier dispatched for `t1` at generation 3.',
      },
    ]
    await runEpicBeat(deps(), group())
    expect(spawns).toHaveLength(0)
  })

  test('the hold is released by EVIDENCE -- the registry seeing that conversation, not the clock', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'in-review', { epic: 'e1' })]
    baton = [
      {
        ts: new Date(nowMs - 1_000).toISOString(),
        kind: 'dispatch',
        convId: 'conv_dead_leg',
        cardId: 't1',
        body: 'Verifier dispatched for `t1` at generation 2.',
      },
    ]
    // Seconds old, but the registry HAS it -- so its silence is a real answer.
    await runEpicBeat(deps(), group({ convIds: ['conv_dead_leg'] }))
    expect(spawns[0].epic).toMatchObject({ role: 'verifier', cardId: 't1' })
  })

  test('a launch that never attaches stops holding its card once the grace is spent', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'open', { epic: 'e1' })]
    baton = [
      {
        ts: new Date(nowMs - SEAT_ATTACH_GRACE_MS - 1_000).toISOString(),
        kind: 'dispatch',
        convId: 'conv_never_landed',
        cardId: 't1',
        body: 'Implementer dispatched for `t1` at generation 1.',
      },
    ]
    await runEpicBeat(deps(), group())
    expect(spawns[0].epic).toMatchObject({ role: 'implementer', cardId: 't1' })
  })

  test('a card whose dependency is unfinished is NOT dispatched', async () => {
    cards = [
      card('e1', 'open', { tags: ['epic'] }),
      card('t1', 'open', { epic: 'e1' }),
      card('t2', 'open', { epic: 'e1', dependsOn: ['t1'] }),
    ]
    await runEpicBeat(deps(), group())
    expect(spawns.map(s => s.epic.cardId)).toEqual(['t1'])
  })

  test('an in-review card gets a VERIFIER, not another implementer', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'in-review', { epic: 'e1' })]
    await runEpicBeat(deps(), group())
    expect(spawns[0].epic).toMatchObject({ role: 'verifier', cardId: 't1' })
  })

  test('a spawn failure is logged and does not abort the remaining actions', async () => {
    cards = [
      card('e1', 'open', { tags: ['epic'] }),
      card('t1', 'open', { epic: 'e1' }),
      card('t2', 'open', { epic: 'e1' }),
    ]
    let first = true
    configureEpicIo({
      dispatchSpawn: mock(async (req: { name: string; epic: Record<string, unknown> }) => {
        if (first) {
          first = false
          return { ok: false, error: 'no capacity' }
        }
        spawns.push({ name: req.name, epic: req.epic })
        return { ok: true, conversationId: 'conv_ok', jobId: 'j' }
      }) as never,
    })
    const out = await runEpicBeat(deps(), group())
    expect(log.join('\n')).toContain('no capacity')
    expect(out.spawned).toHaveLength(1)
  })

  test('all children terminal completes the run and RELEASES the lease', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'done', { epic: 'e1' })]
    await runEpicBeat(deps(), group())
    expect(statusPatch()).toMatchObject({ status: 'complete' })
    expect(ops.some(o => o.op === 'release')).toBe(true)
    expect(baton.some(e => e.kind === 'checkpoint')).toBe(true)
  })

  test('the second dry generation PARKS the run and records why', async () => {
    run = { ...RUN, dryGens: 1 }
    cards = [card('e1', 'open', { tags: ['epic'] })]
    await runEpicBeat(deps(), group())
    expect(statusPatch()).toMatchObject({ status: 'paused' })
    expect(baton.some(e => e.kind === 'checkpoint' && e.body.includes('PARKED'))).toBe(true)
  })

  test('a live overseer holds the beat -- nothing spawns underneath it', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'open', { epic: 'e1' })]
    const out = await runEpicBeat(deps(), group({ overseerAlive: true }))
    expect(out.spawned).toHaveLength(0)
    expect(ops.some(o => o.op === 'lease')).toBe(false)
  })

  test('cadence=window with a closed window holds dispatch but still verifies', async () => {
    run = { ...RUN, cadence: ['window'] }
    cards = [
      card('e1', 'open', { tags: ['epic'] }),
      card('t1', 'open', { epic: 'e1' }),
      card('t2', 'in-review', { epic: 'e1' }),
    ]
    const d = { ...deps(), windowOpen: async () => false } as BeatDeps
    await runEpicBeat(d, group())
    expect(spawns.map(s => s.epic.role)).toEqual(['verifier'])
  })

  test('every beat logs one summary line naming the epic and generation', async () => {
    await runEpicBeat(deps(), group())
    expect(log.some(l => l.includes('[epic e1 gen 3] beat:'))).toBe(true)
  })
})

/**
 * THE RUN CAPS, PERFORMED.
 *
 * `planBeat` decides that a run is over budget; these are the tests that it
 * actually STOPS -- the bar `b766b75e` set after `dryGens` was read every beat,
 * reported in the overseer's briefing, promised by a comment, and never once
 * written. A field that exists is not a brake.
 */
describe('the run caps stop the run', () => {
  const ready = () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'open', { epic: 'e1' })]
  }

  test('a run over its DOLLAR ceiling parks instead of dispatching', async () => {
    ready()
    run = { ...RUN, maxUsd: 25 }
    spendUsd = 31.4
    await runEpicBeat(deps(), group({ convIds: ['conv_a', 'conv_b'] }))
    expect(spawns).toHaveLength(0)
    expect(statusPatch()).toMatchObject({ status: 'paused' })
  })

  test('and says so in the baton, with the figure and the ceiling', async () => {
    ready()
    run = { ...RUN, maxUsd: 25 }
    spendUsd = 31.4
    await runEpicBeat(deps(), group())
    const checkpoint = baton.find(e => e.kind === 'checkpoint')
    expect(checkpoint?.body).toContain('PARKED')
    expect(checkpoint?.body).toContain('$31.40')
    expect(checkpoint?.body).toContain('$25.00')
  })

  test('a run over its WALL-CLOCK ceiling parks instead of dispatching', async () => {
    ready()
    run = { ...RUN, maxWallClockMinutes: 60, startedAt: '2026-08-21T00:00:00.000Z' }
    nowMs = NOW_0 + 61 * 60_000
    await runEpicBeat(deps(), group())
    expect(spawns).toHaveLength(0)
    expect(statusPatch()).toMatchObject({ status: 'paused' })
    expect(baton.find(e => e.kind === 'checkpoint')?.body).toContain('60 minute')
  })

  test('the spend is folded over EVERY conversation the epic has had, not just the live ones', async () => {
    await runEpicBeat(deps(), group({ convIds: ['conv_overseer', 'conv_dead', 'conv_live'] }))
    expect(spendAskedFor).toEqual(['conv_overseer', 'conv_dead', 'conv_live'])
  })

  /**
   * BEFORE THE ACTIONS, not after -- the rule the dry-generation counter
   * established. A beat that dies mid-park must still have banked what it spent,
   * or the ledger resets itself precisely when things are going wrong.
   */
  test('what the run spent is written BEFORE the park it triggered', async () => {
    ready()
    run = { ...RUN, maxUsd: 25 }
    spendUsd = 31.4
    await runEpicBeat(deps(), group())
    const patches = patchOps()
    expect(patches[0]).toMatchObject({ spentUsd: 31.4 })
    expect(patches[1]).toMatchObject({ status: 'paused' })
  })

  /**
   * STICKY. Turns are pruned on a retention window and the conversation registry
   * forgets, so a fresh fold can come back SMALLER than what the run banked. A
   * brake that garbage collection can release is not a brake.
   */
  test('a fold that comes back smaller does NOT lower the ledger', async () => {
    run = { ...RUN, spentUsd: 40 }
    spendUsd = 3
    await runEpicBeat(deps(), group())
    expect(patchOps().some(p => p.spentUsd !== undefined)).toBe(false)
  })

  test('and the cap is judged against the banked figure, not the shrunken fold', async () => {
    ready()
    run = { ...RUN, spentUsd: 40, maxUsd: 25 }
    spendUsd = 3
    await runEpicBeat(deps(), group())
    expect(statusPatch()).toMatchObject({ status: 'paused' })
  })

  /** ONE op for the whole bag. Two counters used to mean two round trips; the
   *  seam exists so the third does not mean a third. */
  test('the ledger is one patch op, however many fields moved', async () => {
    spendUsd = 12
    await runEpicBeat(deps(), group())
    // An empty board makes this beat dry too, so all three ledger fields move at
    // once -- and they cross as ONE op.
    expect(patchOps()).toHaveLength(1)
    expect(patchOps()[0]).toEqual({ dryGens: 1, spentUsd: 12, startedAt: '2026-08-21T00:00:00.000Z' })
  })

  /** The clock starts when the run may WORK, not when it was armed -- a window
   *  run must not spend its budget waiting for the night. */
  test('a shut window does not start the wall clock', async () => {
    run = { ...RUN, cadence: ['window'] }
    const d = { ...deps(), windowOpen: async () => false } as BeatDeps
    await runEpicBeat(d, group())
    expect(patchOps().some(p => p.startedAt !== undefined)).toBe(false)
  })
})

/**
 * THE ACKNOWLEDGEMENT SEAM, end to end -- the bug that froze epic-the-wall for
 * five generations (gens 23-28, 2026-08-19).
 *
 * The truncation happens BETWEEN the two halves: `unacknowledgedCards` is right,
 * the sentinel's prompt-sized tail is right, and putting one into the other is
 * what is wrong. So a double for `fetchEpicRun` cannot see it -- these tests run
 * the REAL sentinel handler over a REAL log file through the REAL broker fold,
 * and stub only the things that would spawn a process.
 */
describe('runEpicBeat against the real sentinel seam', () => {
  const NOW = Date.parse('2026-08-19T19:52:00.000Z')
  /** More settled cards than the sentinel's prompt-sized baton tail holds. */
  const SETTLED = Array.from({ length: 25 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`)
  let root = ''

  const sentinel = (op: 'get' | 'log_append', extra: Record<string, unknown> = {}) =>
    handleEpicOp(root, { type: 'epic_op', requestId: 'r', projectRoot: root, op, epicId: 'e1', ...extra } as never, NOW)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'epic-seam-'))
    mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
    writeFileSync(
      cardPath(root, 'e1', false),
      '---\ntitle: The epic\nstatus: open\ntags: [epic]\n---\n\nBody.\n',
      'utf8',
    )

    // A run mid-flight: planning done, no overseer holding it.
    handleEpicOp(
      root,
      { type: 'epic_op', requestId: 'r', projectRoot: root, op: 'start', epicId: 'e1', start: { plan: false } },
      NOW,
    )
    handleEpicOp(
      root,
      {
        type: 'epic_op',
        requestId: 'r',
        projectRoot: root,
        op: 'patch',
        epicId: 'e1',
        patch: { gen: 3, status: 'running' },
      },
      NOW,
    )

    // Every settled card acknowledged, exactly as `acknowledge` writes it. All 25
    // are in the log; only the last 20 are in the tail the beat is handed.
    for (const cardId of SETTLED) {
      sentinel('log_append', {
        logAppend: { kind: 'completion', convId: 'broker', cardId, body: `Card \`${cardId}\` settled.` },
      })
    }

    // The board as it stands: the epic, its 25 finished children, one awaiting a verdict.
    cards = [
      card('e1', 'open', { tags: ['epic'] }),
      ...SETTLED.map(slug => card(slug, 'done', { epic: 'e1' })),
      card('t1', 'in-review', { epic: 'e1' }),
    ]

    configureEpicIo({
      fetchEpicRun: async (_d, _p, epicId, baton?: EpicBatonQuery) =>
        toEpicRunView(sentinel('get', { ...(baton ? { baton } : {}) }) as EpicResult & { epicId: typeof epicId }),
      appendBaton: async (_d, _p, _e, entry) => sentinel('log_append', { logAppend: entry }) as EpicResult,
    })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('25 acknowledged settles do NOT re-wake the overseer -- the card gets its VERIFIER', async () => {
    const out = await runEpicBeat(deps(), group({ settled: SETTLED }))
    expect(spawns.map(s => s.epic.role)).toEqual(['verifier'])
    expect(spawns[0].epic).toMatchObject({ cardId: 't1' })
    expect(out.note).toContain('verifying 1')
  })

  test('and nothing is acknowledged a second time -- the baton gains no duplicate', async () => {
    await runEpicBeat(deps(), group({ settled: SETTLED }))
    const completions = readEpicLog(root, 'e1').filter(e => e.kind === 'completion')
    expect(completions).toHaveLength(SETTLED.length)
  })

  test('a genuinely new settle still wakes the overseer', async () => {
    const out = await runEpicBeat(deps(), group({ settled: [...SETTLED, 'brand-new'] }))
    expect(out.note).toContain('1 unacknowledged settle(s): brand-new')
    expect(spawns.map(s => s.epic.role)).toEqual(['overseer'])
  })
})

/**
 * THE BOUNCE LANE, end to end, through the REAL sentinel seam.
 *
 * `epic-ready.test.ts` pins the arithmetic; this pins the WIRING, which is the
 * half a pure-fold test cannot reach: the seat count is folded over the whole log
 * sentinel-side, crosses on the `get` reply, and is read back by the beat. A
 * double for `fetchEpicRun` would happily return a number the sentinel never
 * computes.
 *
 * The board is the one generation 4 of `epic-scanner-fabric` woke to: a card the
 * verifier bounced back to `in-progress`, its seat dead, a free concurrency slot,
 * and -- before this -- nothing that would ever pick it up again.
 */
describe('a bounced card, against the real sentinel seam', () => {
  const NOW = Date.parse('2026-08-21T09:50:00.000Z')
  let root = ''

  const sentinel = (op: 'get' | 'log_append', extra: Record<string, unknown> = {}) =>
    handleEpicOp(root, { type: 'epic_op', requestId: 'r', projectRoot: root, op, epicId: 'e1', ...extra } as never, NOW)

  /**
   * One seat going out, exactly as `spawnForCard` records it. Returns the
   * conversation ids it spent, because a bounced card's EARLIER seats are seats
   * the registry has already seen -- `EpicGroup.convIds` is every conversation
   * the epic has ever had, live or dead, and a card cannot be `settled` without
   * its conversation being in there. Handing them to `group()` is what keeps
   * these fixtures shaped like production now that a seat the registry has NOT
   * seen holds its card (`epic-pending-seats.ts`).
   */
  const recordDispatch = (cardId: string, n: number) => {
    const convIds: string[] = []
    for (let i = 0; i < n; i++) {
      const convId = `conv_${cardId}_${i}`
      convIds.push(convId)
      sentinel('log_append', {
        logAppend: { kind: 'dispatch', convId, cardId, body: `Implementer dispatched.` },
      })
    }
    return convIds
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'epic-bounce-'))
    mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
    writeFileSync(
      cardPath(root, 'e1', false),
      '---\ntitle: The epic\nstatus: open\ntags: [epic]\n---\n\nBody.\n',
      'utf8',
    )
    handleEpicOp(
      root,
      { type: 'epic_op', requestId: 'r', projectRoot: root, op: 'start', epicId: 'e1', start: { plan: false } },
      NOW,
    )
    handleEpicOp(
      root,
      { type: 'epic_op', requestId: 'r', projectRoot: root, op: 'patch', epicId: 'e1', patch: { gen: 3 } },
      NOW,
    )
    // The bounce, as the engine actually leaves it: the implementer settled and
    // was acknowledged, then the verifier sent the card back to `in-progress`.
    sentinel('log_append', { logAppend: { kind: 'completion', convId: 'broker', cardId: 't1', body: 'settled' } })
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'in-progress', { epic: 'e1' })]

    configureEpicIo({
      fetchEpicRun: async (_d, _p, epicId, q?: EpicBatonQuery) =>
        toEpicRunView(sentinel('get', { ...(q ? { baton: q } : {}) }) as EpicResult & { epicId: typeof epicId }),
      appendBaton: async (_d, _p, _e, entry) => sentinel('log_append', { logAppend: entry }) as EpicResult,
    })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('gets a fresh IMPLEMENTER -- the generation this project lost to it', async () => {
    const spent = recordDispatch('t1', 2)
    const out = await runEpicBeat(deps(), group({ settled: ['t1'], convIds: spent }))
    expect(spawns.map(s => s.epic.role)).toEqual(['implementer'])
    expect(spawns[0].epic).toMatchObject({ cardId: 't1' })
    expect(out.note).toContain('dispatching 1')
  })

  test('is not woken about again -- its settle was acknowledged generations ago', async () => {
    await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(spawns.some(s => s.epic.role === 'overseer')).toBe(false)
  })

  test('with a live seat on it, nothing goes out', async () => {
    const out = await runEpicBeat(deps(), group({ inFlight: ['t1'] }))
    expect(spawns).toHaveLength(0)
    expect(out.note).toContain('still in flight')
  })

  /** THE CEILING, crossing the wire. The count is folded over the whole log by
   *  the sentinel, so this is the test that proves the field is actually sent. */
  test('stops at the seat ceiling rather than billing a seat every 45s', async () => {
    const spent = recordDispatch('t1', MAX_CARD_SEATS)
    await runEpicBeat(deps(), group({ settled: ['t1'], convIds: spent }))
    expect(spawns.some(s => s.epic.role === 'implementer')).toBe(false)
  })

  test('and says so in the beat note, naming the card', async () => {
    const spent = recordDispatch('t1', MAX_CARD_SEATS)
    const out = await runEpicBeat(deps(), group({ settled: ['t1'], convIds: spent }))
    expect(out.note).toContain('t1')
    expect(out.note).toContain(String(MAX_CARD_SEATS))
  })

  /** The seat it just spent is on the log BEFORE the next beat reads it, which is
   *  the only reason the ceiling can close at all: the conversation behind that
   *  seat carries no epic tag until its agent host connects. */
  test('the seat it spends is counted immediately, without waiting for the conversation', async () => {
    const spent = recordDispatch('t1', MAX_CARD_SEATS - 1)
    await runEpicBeat(deps(), group({ settled: ['t1'], convIds: spent }))
    expect(spawns.map(s => s.epic.role)).toEqual(['implementer'])
    // Second beat, same board, same dead seat -- and the registry still knows
    // nothing about the conversation the first beat spawned. The ceiling closes
    // anyway, because the seat went into the LOG the moment it was spent. What
    // comes out instead is the overseer, woken once on a dry generation, which is
    // the visible-and-stopped shape `unspawnable` already has.
    spawns = []
    await runEpicBeat(deps(), group({ settled: ['t1'], convIds: spent }))
    expect(spawns.some(s => s.epic.role === 'implementer')).toBe(false)
  })
})

/**
 * THE OPEN LANE'S RUNAWAY, end to end.
 *
 * An implementer that ran, produced output and died without moving its own card
 * leaves that card in `open`. The card is therefore still `notStarted`, its
 * conversation is dead so it is not `inFlight`, and it produced output so it is
 * `settled` rather than `unspawnable` -- which means `MAX_LAUNCH_ATTEMPTS` does
 * not apply and the next beat dispatches it again. Every 45 seconds, until a
 * spend cap parks the run.
 *
 * These pin the repair through the REAL sentinel handler: the card is withheld on
 * the FIRST repeat, it is named, and the run goes dry-then-parked instead of
 * billing forever.
 */
describe('an `open` card its seat already ran for, against the real sentinel seam', () => {
  const NOW = Date.parse('2026-08-21T13:40:00.000Z')
  let root = ''

  const sentinel = (op: 'get' | 'log_append', extra: Record<string, unknown> = {}) =>
    handleEpicOp(root, { type: 'epic_op', requestId: 'r', projectRoot: root, op, epicId: 'e1', ...extra } as never, NOW)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'epic-open-lane-'))
    mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
    writeFileSync(
      cardPath(root, 'e1', false),
      '---\ntitle: The epic\nstatus: open\ntags: [epic]\n---\n\nBody.\n',
      'utf8',
    )
    handleEpicOp(
      root,
      { type: 'epic_op', requestId: 'r', projectRoot: root, op: 'start', epicId: 'e1', start: { plan: false } },
      NOW,
    )
    handleEpicOp(
      root,
      { type: 'epic_op', requestId: 'r', projectRoot: root, op: 'patch', epicId: 'e1', patch: { gen: 3 } },
      NOW,
    )
    // The seat that went out, and the settle the beat already acknowledged -- so
    // what these tests observe is the DISPATCH decision and not a pending wake.
    sentinel('log_append', {
      logAppend: { kind: 'dispatch', convId: 'conv_t1_0', cardId: 't1', body: 'Implementer dispatched.' },
    })
    sentinel('log_append', { logAppend: { kind: 'completion', convId: 'broker', cardId: 't1', body: 'settled' } })
    // The card the implementer never moved.
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'open', { epic: 'e1' })]

    configureEpicIo({
      fetchEpicRun: async (_d, _p, epicId, q?: EpicBatonQuery) =>
        toEpicRunView(sentinel('get', { ...(q ? { baton: q } : {}) }) as EpicResult & { epicId: typeof epicId }),
      appendBaton: async (_d, _p, _e, entry) => sentinel('log_append', { logAppend: entry }) as EpicResult,
    })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('gets NO second implementer -- one settled seat is the bound, not six', async () => {
    await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(spawns.some(s => s.epic.role === 'implementer')).toBe(false)
  })

  test('and is NAMED in the beat note, with the moves that re-authorise it', async () => {
    const out = await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(out.note).toContain('t1')
    expect(out.note).toContain('in-review')
    expect(out.note).not.toContain('nothing ready')
  })

  test('a card with no prior seat is still dispatched normally', async () => {
    cards = [...cards, card('t2', 'open', { epic: 'e1' })]
    await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(spawns.filter(s => s.epic.role === 'implementer').map(s => s.epic.cardId)).toEqual(['t2'])
  })

  test('the run stops instead of billing forever: dry generation now, park on the next', async () => {
    const out = await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(out.note).toContain('already ran')
    expect(patchOps().find(p => p.dryGens !== undefined)).toMatchObject({ dryGens: 1 })

    ops = []
    spawns = []
    handleEpicOp(
      root,
      { type: 'epic_op', requestId: 'r', projectRoot: root, op: 'patch', epicId: 'e1', patch: { dryGens: 1 } },
      NOW,
    )
    await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(statusPatch()).toMatchObject({ status: 'paused' })
    expect(spawns.some(s => s.epic.role === 'implementer')).toBe(false)
  })
})

/**
 * THE 2026-08-20 INCIDENT, end to end.
 *
 * A verifier for `t1` died at exit=1 in 1209ms without writing a transcript
 * entry. The sweep called that a settle; the beat wrote a `completion` and woke
 * a generation; the card sat at `in-review` with no verdict and no `## Guard
 * Findings`, and every sweep after did the same thing again.
 *
 * These pin the shape of the repair: the leg is recorded as a FAILED LAUNCH,
 * no overseer is woken for it, and the card gets a verifier that actually runs.
 */
describe('a leg that died without producing anything', () => {
  const leg = { cardId: 't1', convId: 'conv_dead_verifier', role: 'verifier' as const, gen: 3 }

  test('is recorded in the baton as dispatch-failed, not as a completion', async () => {
    await runEpicBeat(deps(), group({ failedLegs: [leg] }))
    const entry = baton.find(e => e.kind === 'dispatch-failed')
    expect(entry).toMatchObject({ cardId: 't1', convId: 'conv_dead_verifier' })
    expect(baton.some(e => e.kind === 'completion')).toBe(false)
  })

  test('says, in the baton, that no work was done -- a log.md reader can tell it apart', async () => {
    await runEpicBeat(deps(), group({ failedLegs: [leg] }))
    const body = baton.find(e => e.kind === 'dispatch-failed')?.body ?? ''
    expect(body).toContain('ENDED WITHOUT PRODUCING ANYTHING')
    expect(body).toContain('dispatchable again')
    // and it points at where the cause actually is
    expect(body).toContain('Spawn FAILED stderr: conv=conv_dea')
  })

  /**
   * The board is the same one the incident had: `t1` sitting at `in-review`
   * with its verifier dead. Before the fix the leg settled, `unacknowledged`
   * was non-empty, and `guardBeat` returned a wake BEFORE `workBeat` ever got
   * to compute a verify action -- so the card was re-verified never and
   * re-considered forever.
   */
  test('does NOT wake an overseer -- it re-verifies, which is the generation the bug used to burn', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'in-review', { epic: 'e1' })]
    await runEpicBeat(deps(), group({ failedLegs: [leg] }))
    expect(spawns.some(s => s.epic.role === 'overseer')).toBe(false)
    expect(ops.some(o => o.op === 'lease')).toBe(false)
    expect(spawns[0].epic).toMatchObject({ role: 'verifier', cardId: 't1' })
  })

  /** The same board, with the leg reported as a SETTLE instead: the old path,
   *  kept beside the new one so the difference is a diff and not a memory. */
  test('a settle on the same board wakes the overseer and verifies nothing', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'in-review', { epic: 'e1' })]
    await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(spawns[0].epic).toMatchObject({ role: 'overseer' })
    expect(spawns.some(s => s.epic.role === 'verifier')).toBe(false)
  })

  test('is written ONCE -- a baton that already names the conversation is left alone', async () => {
    baton = [{ ts: '', kind: 'dispatch-failed', convId: 'conv_dead_verifier', cardId: 't1', body: 'seen' }]
    await runEpicBeat(deps(), group({ failedLegs: [leg] }))
    expect(baton.filter(e => e.kind === 'dispatch-failed')).toHaveLength(1)
  })

  test('a RETRY that also dies gets its own entry -- twice unspawnable is not one bad night', async () => {
    baton = [{ ts: '', kind: 'dispatch-failed', convId: 'conv_dead_verifier', cardId: 't1', body: 'seen' }]
    await runEpicBeat(deps(), group({ failedLegs: [leg, { ...leg, convId: 'conv_dead_again', gen: 4 }] }))
    expect(baton.filter(e => e.kind === 'dispatch-failed')).toHaveLength(2)
  })

  test('is logged, naming card, role and conversation', async () => {
    await runEpicBeat(deps(), group({ failedLegs: [leg] }))
    expect(log.join('\n')).toContain('1 failed launch(es): t1/verifier@conv_dea')
  })
})

/**
 * A CARD RENAMED WHILE ITS SEAT IS STILL TYPING -- the 2026-08-20 double
 * dispatch, end to end.
 *
 * Generation 3 renamed `epic-verifier-spawn-failed-claude-launch` to
 * `epic-verifier-spawn-64char` at 02:46; at 03:15 the beat dispatched a SECOND
 * implementer onto it while the first was still writing to
 * `src/broker/epic-sweep.ts`. The launch tag stamps the card id at spawn time
 * and never revisits it, so the live conversation went on answering to a key
 * nothing asked about any more -- and a card with a live worker became
 * indistinguishable from a card with no worker.
 *
 * The group in these tests is what the sweep really produces: seats keyed on
 * the OLD id, because that is the id they were launched under.
 */
describe('a card renamed under a live seat', () => {
  const OLD = 'epic-verifier-spawn-failed-claude-launch'
  const NEW = 'epic-verifier-spawn-64char'
  const epic = () => card('e1', 'open', { tags: ['epic'] })
  const renamed = (status: TaskStatus) => card(NEW, status, { epic: 'e1', renamedFrom: [OLD] })

  test('is STILL in flight -- no second implementer is sent onto work already being done', async () => {
    cards = [epic(), renamed('open')]
    const out = await runEpicBeat(deps(), group({ inFlight: [OLD] }))
    expect(spawns).toHaveLength(0)
    expect(out.note).toContain('1 still in flight')
  })

  test('in `in-review`, does not collect a SECOND verifier -- the same key, the same defect', async () => {
    cards = [epic(), renamed('in-review')]
    await runEpicBeat(deps(), group({ inFlight: [OLD], inVerify: [OLD] }))
    expect(spawns.some(s => s.epic.role === 'verifier')).toBe(false)
  })

  /** A rename must not resurrect a settle either: the ack was written under the
   *  old id, and re-asking under the new one would wake a generation per sweep. */
  test('a settle already acknowledged under the OLD id does not re-wake the overseer', async () => {
    baton = [{ ts: '', kind: 'completion', convId: 'broker', cardId: OLD, body: 'seen' }]
    cards = [epic(), renamed('done')]
    await runEpicBeat(deps(), group({ settled: [OLD] }))
    expect(baton.filter(e => e.kind === 'completion')).toHaveLength(1)
    expect(spawns.some(s => s.epic.role === 'overseer')).toBe(false)
  })

  /** An unacknowledged one still settles -- under the id the board actually has,
   *  because an entry naming a card nobody can look up is half a baton. */
  test('an unacknowledged settle is written under the CURRENT id', async () => {
    cards = [epic(), renamed('done')]
    await runEpicBeat(deps(), group({ settled: [OLD] }))
    expect(baton[0]).toMatchObject({ kind: 'completion', cardId: NEW })
  })

  /** The other half of the fix: a rename that forgot `renamed_from:` looks
   *  EXACTLY like this, and silence is what cost the run a seat. */
  test('a live seat whose card id matches no card on the board is a WARN, not silence', async () => {
    cards = [epic(), card('t1', 'open', { epic: 'e1' })]
    await runEpicBeat(deps(), group({ inFlight: ['a-card-nobody-has'] }))
    expect(log.join('\n')).toContain('a-card-nobody-has')
    expect(log.join('\n')).toContain('WARN')
  })

  test('an EMPTY board raises no orphan warning -- a failed board read is not a rename', async () => {
    cards = []
    await runEpicBeat(deps(), group({ inFlight: ['t1'] }))
    expect(log.join('\n')).not.toContain('WARN')
  })

  test('a board with no renames at all behaves exactly as before', async () => {
    cards = [epic(), card('t1', 'open', { epic: 'e1' })]
    await runEpicBeat(deps(), group())
    expect(spawns[0].epic).toMatchObject({ role: 'implementer', cardId: 't1' })
  })
})

/**
 * THE BOUND, performed. Gen 2 spent thirteen seats on one card; a fix that only
 * stopped the false settle would have spent them a beat apart instead.
 */
describe('a card the engine has given up on', () => {
  const legs = ['a', 'b', 'c'].map(s => ({ cardId: 't1', convId: `conv_dead_${s}`, role: 'verifier' as const, gen: 3 }))
  const gave_up = () => group({ failedLegs: legs, unspawnable: ['t1'] })

  test('gets NO further verifier, however long it sits in in-review', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'in-review', { epic: 'e1' })]
    await runEpicBeat(deps(), gave_up())
    expect(spawns.some(s => s.epic.role === 'verifier')).toBe(false)
  })

  test('gets NO further implementer either -- the launch is what fails, not the role', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'open', { epic: 'e1' })]
    await runEpicBeat(deps(), gave_up())
    expect(spawns.some(s => s.epic.role === 'implementer')).toBe(false)
  })

  test('becomes VISIBLE: the baton entry that trips the bound says the engine has stopped', async () => {
    await runEpicBeat(deps(), gave_up())
    const bodies = baton.filter(e => e.kind === 'dispatch-failed').map(e => e.body)
    expect(bodies).toHaveLength(3)
    expect(bodies.every(b => b.includes('WILL NOT BE DISPATCHED OR VERIFIED AGAIN'))).toBe(true)
    expect(bodies.some(b => b.includes('an id too long for a worktree name'))).toBe(true)
  })

  test('and the run stops instead of idling: dry generation now, park on the next', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'in-review', { epic: 'e1' })]
    const out = await runEpicBeat(deps(), gave_up())
    expect(out.note).toContain('seats keep dying')
    expect(ops.find(o => o.op === 'patch')?.patch).toMatchObject({ dryGens: 1 })

    // Second beat, same state: the run PARKS rather than retrying forever.
    run = { ...RUN, dryGens: 1 }
    ops = []
    await runEpicBeat(deps(), gave_up())
    expect(statusPatch()).toMatchObject({ status: 'paused' })
  })
})

/**
 * THE PROMISE LEDGER, END TO END through a whole beat.
 *
 * A PROMISE IS CLOSED BY A COMMIT ON main. NOTHING ELSE CLOSES IT -- not a card
 * moved to `done`, not a seat saying it finished. These are the tests that prove
 * the sha lands in the card's front matter written by the EXECUTOR, and that a
 * sha it cannot resolve leaves the card alone and says so in the baton.
 */
describe('the beat writes `closes:` for a card it settled', () => {
  /** What `cardBranch('e1', 't1')` resolves to. */
  const BRANCH = 'worktree-epic/e1/t1'
  const SHA = 'f'.repeat(40)
  const CARD_REL = '.rclaude/project/cards/t1.md'
  const CARD_TEXT = '---\ntitle: "The work"\nstatus: done\nepic: e1\n---\n\nBody.\n'

  let files: Map<string, string>
  /** What the (stubbed) commit ledger answers for the card's branch. */
  let ledger: { via: 'merge' | 'branch'; commits: CommitRow[] } | null

  const ledgerRow = (over: Partial<CommitRow> = {}) =>
    ({
      hash: SHA,
      shortHash: SHA.slice(0, 8),
      branch: BRANCH,
      subject: 'feat(t1): the work',
      conversationId: 'conv_impl',
      conversationName: 'werk-t1',
      ...over,
    }) as CommitRow

  beforeEach(() => {
    files = new Map([[CARD_REL, CARD_TEXT]])
    ledger = { via: 'branch', commits: [ledgerRow()] }
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'done', { epic: 'e1' })]

    configureEpicIo({
      commitsForBranch: (_project, branch) => (branch === BRANCH ? ledger : null),
      readProjectFile: async (_d, _p, relPath) => {
        const content = files.get(relPath)
        return content === undefined
          ? { type: 'project_read_file_result', requestId: 'r', ok: false, error: 'ENOENT' }
          : { type: 'project_read_file_result', requestId: 'r', ok: true, content, size: content.length }
      },
      writeProjectFile: async (_d, _p, relPath, content) => {
        files.set(relPath, content)
        return { type: 'project_write_file_result', requestId: 'r', ok: true, size: content.length }
      },
    })
  })

  test('the settled card ends up naming the commit that delivered it', async () => {
    await runEpicBeat(deps(), group({ settled: ['t1'] }))

    const written = files.get(CARD_REL) ?? ''
    expect(parsePromiseBlock(written)?.closes).toEqual([SHA])
    expect(written).toContain('# feat(t1): the work')
    // Line surgery: everything outside the block is byte-identical.
    expect(written).toContain('---\ntitle: "The work"\nstatus: done\nepic: e1\npromise:\n')
    expect(written.endsWith('---\n\nBody.\n')).toBe(true)
  })

  test('and the write is recorded in the baton, as a `record` that acknowledges nothing', async () => {
    await runEpicBeat(deps(), group({ settled: ['t1'] }))

    const entry = baton.find(e => e.kind === 'record')
    expect(entry).toMatchObject({ convId: 'broker', cardId: 't1' })
    expect(entry?.body).toContain(SHA.slice(0, 12))
    // `acknowledgedCardIds` folds `completion` and `verdict` only -- a record
    // must never stand in for the settle the overseer is woken for.
    expect(acknowledgedCardIds(baton)).toEqual(['t1'])
    expect(baton.filter(e => e.kind === 'completion')).toHaveLength(1)
  })

  /** `could not verify` is never folded into `delivered`, and a guessed sha is
   *  not a verdict. */
  test('an unresolvable sha writes NOTHING and says so in the baton', async () => {
    ledger = null
    await runEpicBeat(deps(), group({ settled: ['t1'] }))

    expect(files.get(CARD_REL)).toBe(CARD_TEXT)
    expect(baton.find(e => e.kind === 'record')?.body).toContain('PROMISE NOT RECORDED')
  })

  /**
   * INVERTED, and deliberately kept in that shape. This asserted that a settled
   * card awaiting its verdict was left alone, because the verdict's board write
   * flattened the promise block. That is fixed on main (`2ba978d0`), so the card
   * gets its `closes:` the beat its implementer ends -- the acknowledgement
   * moment the card specified all along.
   */
  test('a settled card still awaiting its verdict IS written, at acknowledgement', async () => {
    cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'in-review', { epic: 'e1' })]
    await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(parsePromiseBlock(files.get(CARD_REL) ?? '')?.closes).toEqual([SHA])
  })

  test('a board write that fails loses the card, never the beat', async () => {
    configureEpicIo({
      writeProjectFile: async () => ({
        type: 'project_write_file_result',
        requestId: 'r',
        ok: false,
        error: 'no sentinel connected for project',
      }),
    })
    const out = await runEpicBeat(deps(), group({ settled: ['t1'] }))

    expect(out.error).toBeUndefined()
    expect(baton.find(e => e.kind === 'record')?.body).toContain('no work was blocked')
    // The settle still reached the overseer: bookkeeping never costs a wake.
    expect(spawns.map(s => s.epic.role)).toEqual(['overseer'])
  })

  /**
   * REGRESSION -- THE LAST CARD OF AN EPIC. Reported as F1 against the first cut
   * of this feature, reproduced end to end, and fixed by `recordFinalPromises`.
   *
   * The race, which is not hypothetical: `planEpic` completes a run off card
   * LANES alone and does not wait for the conversations behind them. So on the
   * beat where the last child first reads `done` while its verifier is still
   * alive, the card is NOT settled -- the per-beat pass skips it -- and the same
   * beat then flips the run to `complete`. Every later beat returns at
   * `isInertRun` before a card is read. There is no next beat, and the card's
   * `closes:` used to stay empty forever.
   *
   * Note the local `sendEpicOp`: unless a status patch actually MOVES the run,
   * the second beat never sees the inert short circuit and the test cannot fail
   * the way the bug did.
   */
  describe('LAST CALL -- the beat that ends the run', () => {
    /** As the real sentinel behaves: a `patch { status }` moves the run. */
    const withLiveRunStatus = () =>
      configureEpicIo({
        sendEpicOp: async (_d, _p, op) => {
          ops.push({ op: op.op, patch: op.patch, lease: op.lease })
          const status = (op.patch as Record<string, unknown> | undefined)?.status
          if (op.op === 'patch' && typeof status === 'string' && run) {
            run = { ...run, status: status as EpicRunSnapshot['status'] }
          }
          if (op.op === 'lease') {
            return {
              type: 'epic_result',
              requestId: 'r',
              op: 'lease',
              ok: true,
              lease: { granted: true, convId: 'conv_overseer', gen: 4, at: '' },
            } as EpicResult
          }
          return { type: 'epic_result', requestId: 'r', op: op.op, ok: true } as EpicResult
        },
      })

    test('a card that is `done` while its verifier is still alive still gets its `closes:`', async () => {
      withLiveRunStatus()

      // The card reads `done`, but its verifier has not exited, so it is in
      // NOBODY's settled list. This beat is the last one that will ever run.
      await runEpicBeat(deps(), group({ settled: [], inFlight: ['t1'], inVerify: ['t1'] }))

      expect(run?.status).toBe('complete')
      expect(parsePromiseBlock(files.get(CARD_REL) ?? '')?.closes).toEqual([SHA])
    })

    test('and the beat AFTER it is inert, so the write had to happen on that beat', async () => {
      withLiveRunStatus()
      await runEpicBeat(deps(), group({ settled: [], inFlight: ['t1'], inVerify: ['t1'] }))

      files.set(CARD_REL, CARD_TEXT)
      const out = await runEpicBeat(deps(), group({ settled: ['t1'] }))

      expect(out.note).toContain('not touched')
      // Proof the earlier write was the ONLY chance: the second beat reads no
      // card at all, so a fix that relied on it would record nothing.
      expect(files.get(CARD_REL)).toBe(CARD_TEXT)
    })

    test('the write happens BEFORE the run is patched complete', async () => {
      withLiveRunStatus()
      const order: string[] = []
      configureEpicIo({
        writeProjectFile: async (_d, _p, relPath, content) => {
          order.push('card')
          files.set(relPath, content)
          return { type: 'project_write_file_result', requestId: 'r', ok: true, size: content.length }
        },
      })
      const outer = epicIo().sendEpicOp
      configureEpicIo({
        sendEpicOp: async (d, p, op) => {
          if (op.op === 'patch' && (op.patch as Record<string, unknown> | undefined)?.status) order.push('complete')
          return outer(d, p, op)
        },
      })

      await runEpicBeat(deps(), group({ settled: [], inFlight: ['t1'], inVerify: ['t1'] }))
      expect(order).toEqual(['card', 'complete'])
    })

    /** A PARK is terminal for the sweep too, and it can fire with children still
     *  being worked. Their lanes are the only evidence at last call, so an
     *  unfinished card gets nothing -- a promise is a claim about finished work. */
    test('a PARKED run records its terminal children and leaves the unfinished ones alone', async () => {
      withLiveRunStatus()
      run = { ...RUN, dryGens: 1 }
      cards = [
        card('e1', 'open', { tags: ['epic'] }),
        card('t1', 'done', { epic: 'e1' }),
        card('t2', 'in-progress', { epic: 'e1' }),
      ]
      files.set('.rclaude/project/cards/t2.md', CARD_TEXT)

      const legs = ['a', 'b', 'c'].map(s => ({
        cardId: 't2',
        convId: `conv_dead_${s}`,
        role: 'verifier' as const,
        gen: 3,
      }))
      await runEpicBeat(deps(), group({ failedLegs: legs, unspawnable: ['t2'] }))

      expect(statusPatch()).toMatchObject({ status: 'paused' })
      expect(parsePromiseBlock(files.get(CARD_REL) ?? '')?.closes).toEqual([SHA])
      expect(files.get('.rclaude/project/cards/t2.md')).toBe(CARD_TEXT)
    })

    /** At last call "we will ask again next beat" is a lie -- there is no next
     *  beat. A refusal that was retryable a moment ago is now the final word. */
    test('an unresolvable sha at last call is announced as FINAL, not as a retry', async () => {
      withLiveRunStatus()
      ledger = null

      await runEpicBeat(deps(), group({ settled: [], inFlight: ['t1'], inVerify: ['t1'] }))

      const body = baton.find(e => e.kind === 'record')?.body ?? ''
      expect(body).toContain('PROMISE NOT RECORDED')
      expect(body).toContain('this is FINAL')
      expect(files.get(CARD_REL)).toBe(CARD_TEXT)
    })

    /** The two passes are layered, not duplicated: a card recorded at
     *  acknowledgement is not read, rewritten or re-announced at last call. */
    test('a card already recorded this run is not written twice', async () => {
      withLiveRunStatus()
      cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'done', { epic: 'e1' })]

      await runEpicBeat(deps(), group({ settled: ['t1'] }))

      expect(baton.filter(e => e.kind === 'record')).toHaveLength(1)
      expect(parsePromiseBlock(files.get(CARD_REL) ?? '')?.closes).toEqual([SHA])
    })
  })
})
