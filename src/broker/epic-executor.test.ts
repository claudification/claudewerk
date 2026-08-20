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

const deps = () =>
  ({
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
    spawnContext: {},
    log: (line: string) => log.push(line),
    windowOpen: async () => true,
    now: () => 1_700_000_000_000,
  }) as unknown as BeatDeps

beforeEach(() => {
  log = []
  baton = []
  ops = []
  spawns = []
  leaseGranted = true
  cards = []
  run = { ...RUN }

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
    expect(ops.find(o => o.op === 'patch')?.patch).toMatchObject({ status: 'complete' })
    expect(ops.some(o => o.op === 'release')).toBe(true)
    expect(baton.some(e => e.kind === 'checkpoint')).toBe(true)
  })

  test('the second dry generation PARKS the run and records why', async () => {
    run = { ...RUN, dryGens: 1 }
    cards = [card('e1', 'open', { tags: ['epic'] })]
    await runEpicBeat(deps(), group())
    expect(ops.find(o => o.op === 'patch')?.patch).toMatchObject({ status: 'paused' })
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
