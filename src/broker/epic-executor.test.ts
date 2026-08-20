import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleEpicOp } from '../sentinel/epic-handlers'
import { acknowledgedCardIds, readEpicLog } from '../shared/epic-log'
import type { EpicLogEntry } from '../shared/epic-run-types'
import { cardPath } from '../shared/project-paths'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { EpicBatonQuery, EpicResult, EpicRunSnapshot } from '../shared/protocol'
import type { TaskStatus } from '../shared/task-statuses'
import { toEpicRunView } from './epic-broker-rpc'
import { type BeatDeps, runEpicBeat } from './epic-executor'
import { configureEpicIo, resetEpicIo } from './epic-io'
import type { EpicGroup } from './epic-sweep'

const PROJECT = 'claude://studio/proj'

const RUN: EpicRunSnapshot = {
  epicId: 'e1',
  project: PROJECT,
  cadence: 'now',
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

  configureEpicIo({
    // `baton` here is the WHOLE log, so folding it is the honest answer. The
    // seam tests below are the ones that exercise a truncated tail.
    fetchEpicRun: async () => ({
      run,
      baton,
      acknowledgedCardIds: acknowledgedCardIds(baton),
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
        lease: { convId: 'conv_dead', gen: 3, at: '' },
      }),
    })
    await runEpicBeat(deps(), group({ settled: ['t1'] }))
    expect(ops.find(o => o.op === 'lease')?.lease?.expectGen).toBe(3)
    expect(log.join('\n')).not.toContain('generation DRIFT')
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
    run = { ...RUN, cadence: 'window' }
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
    expect(patchOps().some(p => p.spentUsd !== undefined)) .toBe(false)
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
    run = { ...RUN, cadence: 'window' }
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
