/**
 * Nightshift guardian tests. The guardians reach the outside world through
 * exactly one module dep -- `sendNightshiftOp` (the sentinel RPC) -- so we mock
 * it and inject the ACTION seams (deliverPoke / investigate / dispatchRetry /
 * notify / emit) as spies on the GuardianDeps. Drives the poke bound + backoff,
 * the mechanical terminal stamp, the crash retry ladder, and the attempt cap.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Conversation, GuardianEvent, NightshiftResult, TerminationSource } from '../shared/protocol'
import type { GuardianDeps } from './nightshift-guardian-core'
import type { CrashContext } from './nightshift-investigator'

interface OpCall {
  op: string
  taskPatch?: { id: string; status?: string; note?: string; attempts?: number }
  [k: string]: unknown
}

let opCalls: OpCall[] = []
/** Task the fake sentinel returns for `snapshot`. */
let snapshotTask: { id: string; status: string; attempts?: number } | null = {
  id: '001',
  status: 'running',
  attempts: 0,
}

mock.module('./nightshift-broker-rpc', () => ({
  sendNightshiftOp: async (_deps: unknown, _project: string, op: OpCall): Promise<NightshiftResult> => {
    opCalls.push(op)
    const base = { type: 'nightshift_result' as const, requestId: '', op: op.op, ok: true }
    if (op.op === 'snapshot')
      return { ...base, snapshot: { tasks: snapshotTask ? [snapshotTask] : [] } } as unknown as NightshiftResult
    return base as unknown as NightshiftResult
  },
}))

const { handleOrphanTask } = await import('./nightshift-guardian-settle')
const { sweepGuardians } = await import('./nightshift-guardians')
const { __resetGuardianStateForTest } = await import('./nightshift-guardian-core')

const IDS = { project: 'claude://default/p', runId: '2026-07-05', taskId: '001' }

let clock = 1_000_000
let pokeReturns = true
let investigateResult = {
  verdict: 'retryable' as const,
  hintKey: 'cwd-removed',
  remedy: 'respawn at root',
  reason: 'known',
}
let retryReturns = true
let events: GuardianEvent[] = []
const deliverPoke = mock((_conv: Conversation) => pokeReturns)
const investigate = mock(async (_ctx: CrashContext) => investigateResult)
const dispatchRetry = mock(async (_ctx: CrashContext, _nextAttempt: number, _remedy?: string) => retryReturns)
const notify = mock(() => {})

function deps(): GuardianDeps {
  const noop = () => undefined
  return {
    getAllConversations: () => [],
    getActiveConversationCount: () => 0,
    getConversationSocket: () => undefined,
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: noop,
    removeProjectListener: noop,
    broadcastScoped: noop,
    now: () => clock,
    maxPokes: 2,
    pokeBackoffMs: 90_000,
    attemptCap: 3,
    investigate,
    dispatchRetry,
    deliverPoke,
    notify,
    emit: (ev: GuardianEvent) => {
      events.push(ev)
    },
  } as unknown as GuardianDeps
}

function endedConv(source: TerminationSource, attempts?: number): Conversation {
  return {
    id: 'conv-1',
    project: IDS.project,
    status: 'ended',
    lastActivity: clock,
    resolvedProfile: 'work',
    endedBy: { source, at: clock, detail: { ccExitCode: source === 'cc-exit-crash' ? 1 : 0, note: 'boom' } },
    launchConfig: { nightshift: { runId: IDS.runId, taskId: IDS.taskId } },
    lastError: attempts !== undefined ? { errorMessage: 'ENOENT uv_cwd', timestamp: clock } : undefined,
  } as unknown as Conversation
}

beforeEach(() => {
  opCalls = []
  events = []
  clock = 1_000_000
  pokeReturns = true
  retryReturns = true
  snapshotTask = { id: '001', status: 'running', attempts: 0 }
  investigateResult = { verdict: 'retryable', hintKey: 'cwd-removed', remedy: 'respawn at root', reason: 'known' }
  deliverPoke.mockClear()
  investigate.mockClear()
  dispatchRetry.mockClear()
  notify.mockClear()
  __resetGuardianStateForTest()
})

const patches = () => opCalls.filter(o => o.op === 'task_patch')
const kinds = () => events.map(e => e.kind)

describe('poke protocol (§2a)', () => {
  test('bounded pokes with backoff, then a mechanical terminal stamp', async () => {
    const conv = endedConv('ws-close')
    const d = deps()

    // Poke #1
    await handleOrphanTask(d, IDS, conv)
    expect(deliverPoke).toHaveBeenCalledTimes(1)
    expect(kinds()).toEqual(['poke'])
    expect(patches()).toHaveLength(0) // not stamped yet

    // Same tick -> backing off, no second poke
    await handleOrphanTask(d, IDS, conv)
    expect(deliverPoke).toHaveBeenCalledTimes(1)

    // After the backoff window -> poke #2
    clock += 90_001
    await handleOrphanTask(d, IDS, conv)
    expect(deliverPoke).toHaveBeenCalledTimes(2)

    // Pokes exhausted -> mechanical errored/unresponsive stamp + notify
    clock += 90_001
    await handleOrphanTask(d, IDS, conv)
    expect(deliverPoke).toHaveBeenCalledTimes(2) // no third poke
    const p = patches().at(-1)
    expect(p?.taskPatch?.status).toBe('errored')
    expect(p?.taskPatch?.note).toMatch(/unresponsive/)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(kinds()).toContain('poke-exhausted')
    expect(kinds()).toContain('terminal-error')
  })

  test('a task with a terminal card is left alone', async () => {
    snapshotTask = { id: '001', status: 'done' }
    await handleOrphanTask(deps(), IDS, endedConv('cc-exit-normal'))
    expect(deliverPoke).not.toHaveBeenCalled()
    expect(patches()).toHaveLength(0)
  })
})

describe('crash investigator + attempt cap (§6d)', () => {
  test('retryable crash -> attempts bumped in frontmatter + fresh leg dispatched', async () => {
    snapshotTask = { id: '001', status: 'running', attempts: 1 }
    await handleOrphanTask(deps(), IDS, endedConv('cc-exit-crash', 1))
    expect(investigate).toHaveBeenCalledTimes(1)
    const bump = patches().find(p => p.taskPatch?.attempts !== undefined)
    expect(bump?.taskPatch?.attempts).toBe(2)
    expect(bump?.taskPatch?.status).toBe('running')
    expect(dispatchRetry).toHaveBeenCalledTimes(1)
    expect(dispatchRetry.mock.calls[0][1]).toBe(2) // nextAttempt
    expect(dispatchRetry.mock.calls[0][2]).toBe('respawn at root') // remedy
    expect(kinds()).toContain('retry')
  })

  test('fatal verdict -> terminal errored, no retry', async () => {
    investigateResult = {
      verdict: 'fatal' as unknown as 'retryable',
      hintKey: undefined as unknown as string,
      remedy: undefined as unknown as string,
      reason: 'unfixable',
    }
    await handleOrphanTask(deps(), IDS, endedConv('cc-exit-crash', 1))
    expect(dispatchRetry).not.toHaveBeenCalled()
    expect(patches().at(-1)?.taskPatch?.status).toBe('errored')
    expect(patches().at(-1)?.taskPatch?.note).toMatch(/crash-fatal/)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  test('attempt cap (3) reached -> terminal, investigator never runs', async () => {
    snapshotTask = { id: '001', status: 'running', attempts: 3 }
    await handleOrphanTask(deps(), IDS, endedConv('cc-exit-crash', 3))
    expect(investigate).not.toHaveBeenCalled()
    expect(dispatchRetry).not.toHaveBeenCalled()
    expect(patches().at(-1)?.taskPatch?.status).toBe('errored')
    expect(kinds()).toContain('cap-hit')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  test('retry respawn failure -> terminal crash-fatal', async () => {
    snapshotTask = { id: '001', status: 'running', attempts: 0 }
    retryReturns = false
    await handleOrphanTask(deps(), IDS, endedConv('cc-exit-crash', 0))
    expect(dispatchRetry).toHaveBeenCalledTimes(1)
    expect(patches().at(-1)?.taskPatch?.status).toBe('errored')
    expect(notify).toHaveBeenCalledTimes(1)
  })
})

describe('sweep grouping', () => {
  test('a task with a LIVE conversation is skipped (no poke)', async () => {
    const live = { ...endedConv('cc-exit-normal'), id: 'conv-live', status: 'active' } as Conversation
    const dead = endedConv('ws-close')
    const d = { ...deps(), getAllConversations: () => [dead, live] } as GuardianDeps
    await sweepGuardians(d)
    expect(deliverPoke).not.toHaveBeenCalled()
    expect(patches()).toHaveLength(0)
  })

  test('an orphaned (all-dead) non-terminal task gets poked', async () => {
    const dead = endedConv('ws-close')
    const d = { ...deps(), getAllConversations: () => [dead] } as GuardianDeps
    await sweepGuardians(d)
    expect(deliverPoke).toHaveBeenCalledTimes(1)
  })
})
