/**
 * THE LANDING GATE, END TO END through one beat.
 *
 * The rule, the plan arithmetic and the escalation ledger each have their own
 * unit test. What only this level can prove is the wiring: that the executor
 * DERIVES the fact from git every beat and hands the same array to the plan and
 * to the decision, that a `run.md` write which FAILS leaves the gate exactly
 * where it was, and that the 15-second git scan is bought only when it can change
 * an answer.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { CommitRow } from '../shared/commit-ledger'
import type { EpicLease } from '../shared/epic-lease'
import { acknowledgedCardIds, dispatchCountsByCard } from '../shared/epic-log'
import type { EpicLogEntry } from '../shared/epic-run-types'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { EpicResult, EpicRunSnapshot } from '../shared/protocol'
import type { TaskStatus } from '../shared/task-statuses'
import { type BeatDeps, runEpicBeat } from './epic-executor'
import { configureEpicIo, resetEpicIo } from './epic-io'
import { resetPromiseMemory } from './epic-promise'
import { cardBranch } from './epic-spawn-plan'
import type { EpicGroup } from './epic-sweep'
import type { GitDirt } from './epic-types'

const PROJECT = 'claude://studio/proj'

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
  concurrency: 3,
  plan: false,
  planned: true,
  created: '',
  updated: '',
  digest: '',
}

function card(slug: string, status: TaskStatus, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return { slug, status, title: slug, tags: [], refs: [], created: '', mtime: 1, bodyPreview: '', epic: 'e1', ...over }
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

const branchOf = (slug: string) => cardBranch('e1', slug)
const commit = (hash: string): CommitRow => ({ hash }) as CommitRow

let baton: EpicLogEntry[]
let ops: Array<{ op: string; patch?: Record<string, unknown> }>
let spawns: Array<{ name: string; prompt: string }>
let cards: ProjectTaskMeta[]
let run: EpicRunSnapshot
let lease: EpicLease | null
let ledger: Record<string, 'merge' | 'branch'>
let patchOk: boolean
/** How many times the beat bought the git-fabric round trip. */
let dirtCalls: number
let dirt: GitDirt

const patches = () => ops.filter(o => o.op === 'patch').map(o => o.patch ?? {})
const prompts = () => spawns.map(s => s.prompt).join('\n')

const deps = (over: Partial<BeatDeps> = {}) =>
  ({
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
    spawnContext: {},
    log: () => {},
    windowOpen: async () => true,
    now: () => Date.parse('2026-08-22T00:00:00.000Z'),
    epicSpendUsd: () => 0,
    gitDirt: async () => {
      dirtCalls += 1
      return dirt
    },
    ...over,
  }) as unknown as BeatDeps

beforeEach(() => {
  baton = []
  ops = []
  spawns = []
  cards = []
  run = { ...RUN }
  lease = { convId: '', gen: 3, at: '' }
  ledger = {}
  patchOk = true
  dirtCalls = 0
  dirt = { ok: true, dirty: new Set(), known: new Set() }
  resetPromiseMemory()

  configureEpicIo({
    fetchEpicRun: async () => ({
      run,
      baton,
      acknowledgedCardIds: acknowledgedCardIds(baton),
      dispatchCounts: dispatchCountsByCard(baton),
      lease,
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
      ops.push({ op: op.op, patch: op.patch as Record<string, unknown> })
      if (op.op === 'lease') {
        return {
          type: 'epic_result',
          requestId: 'r',
          op: 'lease',
          ok: true,
          lease: { granted: true, convId: 'conv_wm', gen: (op.lease?.expectGen ?? 0) + 1, at: '' },
        } as EpicResult
      }
      if (op.op === 'patch' && !patchOk) {
        return {
          type: 'epic_result',
          requestId: 'r',
          op: 'patch',
          ok: false,
          error: 'sentinel timed out',
        } as EpicResult
      }
      return { type: 'epic_result', requestId: 'r', op: op.op, ok: true } as EpicResult
    },
    dispatchSpawn: mock(async (req: { name: string; prompt: string }) => {
      spawns.push({ name: req.name, prompt: req.prompt })
      return { ok: true, conversationId: `conv_${spawns.length}`, jobId: 'j' }
    }) as never,
    commitLedgerReady: () => true,
    commitsForBranch: (_project: string, branch: string) => {
      const via = ledger[branch]
      return via ? { via, commits: [commit('abc1234')] } : null
    },
  })
})

afterEach(() => {
  resetEpicIo()
})

describe('a `done` card whose branch never reached main', () => {
  beforeEach(() => {
    cards = [
      card('e1', 'open', { tags: ['epic'], epic: undefined }),
      card('dep', 'done'),
      card('child', 'open', { dependsOn: ['dep'] }),
    ]
    ledger[branchOf('dep')] = 'branch'
  })

  test('its dependent is NOT dispatched, and the werk-master is woken instead', async () => {
    const out = await runEpicBeat(deps(), group())
    expect(spawns).toHaveLength(1)
    expect(prompts()).toContain('Woken by: unmerged-work')
    expect(out.note).toContain(branchOf('dep'))
  })

  test('the werk-master prompt names the branch it has to merge', async () => {
    await runEpicBeat(deps(), group())
    expect(prompts()).toContain('WORK THAT IS NOT DELIVERED (1)')
    expect(prompts()).toContain(branchOf('dep'))
  })

  test('the escalation is persisted against the generation, and nothing else is', async () => {
    await runEpicBeat(deps(), group())
    expect(patches().find(p => p.unlandedWoken !== undefined)).toMatchObject({ unlandedWoken: 'dep@3' })
    // MERGED-NESS ITSELF IS NEVER WRITTEN. If it were, a card that merged later
    // would need somebody to come back and clear the mark.
    expect(JSON.stringify(patches())).not.toContain('unmerged')
  })

  test('once merged, the very next beat dispatches the dependent with nothing un-set', async () => {
    ledger[branchOf('dep')] = 'merge'
    run = { ...run, unlandedWoken: 'dep@3' }
    await runEpicBeat(deps(), group())
    expect(spawns.map(s => s.name).join(' ')).toContain('child')
  })

  test('the same card still unmerged a generation later PARKS the run', async () => {
    run = { ...run, unlandedWoken: 'dep@3' }
    lease = { convId: '', gen: 4, at: '' }
    await runEpicBeat(deps(), group())
    const parked = patches().find(p => p.status === 'paused')
    expect(parked).toBeDefined()
    expect(baton.some(e => e.body.includes(branchOf('dep')))).toBe(true)
  })
})

describe('DERIVED, so a run.md that cannot be written changes nothing', () => {
  test('the same beat with a FAILING patch withholds exactly the same work', async () => {
    cards = [
      card('e1', 'open', { tags: ['epic'], epic: undefined }),
      card('dep', 'done'),
      card('child', 'open', { dependsOn: ['dep'] }),
    ]
    ledger[branchOf('dep')] = 'branch'

    patchOk = false
    const failed = await runEpicBeat(deps(), group())
    const failedSpawns = spawns.map(s => s.name)

    // Same inputs, a working sentinel.
    baton = []
    ops = []
    spawns = []
    patchOk = true
    const fine = await runEpicBeat(deps(), group())

    expect(failedSpawns).toEqual(spawns.map(s => s.name))
    expect(failed.note).toBe(fine.note)
  })
})

describe('the git-fabric round trip is bought only when it can change an answer', () => {
  test('never on a beat with work still moving', async () => {
    cards = [card('e1', 'open', { tags: ['epic'], epic: undefined }), card('a', 'done'), card('b', 'open')]
    ledger[branchOf('a')] = 'merge'
    await runEpicBeat(deps(), group())
    expect(dirtCalls).toBe(0)
  })

  test('bought on the beat that would otherwise complete the run', async () => {
    cards = [card('e1', 'open', { tags: ['epic'], epic: undefined }), card('a', 'done')]
    ledger[branchOf('a')] = 'merge'
    await runEpicBeat(deps(), group())
    expect(dirtCalls).toBe(1)
    expect(patches().some(p => p.status === 'complete')).toBe(true)
  })

  test('a worktree still standing REFUSES the completion', async () => {
    cards = [card('e1', 'open', { tags: ['epic'], epic: undefined }), card('a', 'done')]
    ledger[branchOf('a')] = 'merge'
    dirt = { ok: true, dirty: new Set(), known: new Set([branchOf('a')]) }
    await runEpicBeat(deps(), group())
    expect(patches().some(p => p.status === 'complete')).toBe(false)
    expect(prompts()).toContain('worktree-remove.sh')
  })

  test('a beat with no `gitDirt` wired completes as it always did', async () => {
    cards = [card('e1', 'open', { tags: ['epic'], epic: undefined }), card('a', 'done')]
    ledger[branchOf('a')] = 'merge'
    await runEpicBeat(deps({ gitDirt: undefined }), group())
    expect(patches().some(p => p.status === 'complete')).toBe(true)
  })
})

describe('the FRICTION entry reaches the baton', () => {
  test('three hand-merges in one run write a structured entry naming the operation', async () => {
    cards = [
      card('e1', 'open', { tags: ['epic'], epic: undefined }),
      card('a', 'done'),
      card('b', 'done'),
      card('c', 'done'),
    ]
    for (const slug of ['a', 'b', 'c']) ledger[branchOf(slug)] = 'branch'
    await runEpicBeat(deps(), group())
    const friction = baton.find(e => e.kind === 'friction')
    expect(friction).toBeDefined()
    expect(friction?.body).toContain('FRICTION x3')
    expect(friction?.body).toContain('Automate the merge')
    // A fact about the RUN, not about whichever card happened to be third.
    expect(friction?.cardId).toBeUndefined()
  })
})
