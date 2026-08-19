import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { EpicLogEntry } from '../shared/epic-run-types'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { EpicResult, EpicRunSnapshot } from '../shared/protocol'
import type { TaskStatus } from '../shared/task-statuses'
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
    fetchEpicRun: async () => ({ run, baton, lease: null, ...(run ? {} : { error: 'no run' }) }),
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
    configureEpicIo({ fetchEpicRun: async () => ({ run, baton, lease: { convId: 'conv_holder', gen: 4, at: '' } }) })
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
