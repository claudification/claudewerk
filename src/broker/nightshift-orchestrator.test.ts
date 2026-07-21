/**
 * Nightshift orchestrator drain tests. The orchestrator talks to the outside
 * world through exactly two module deps -- `dispatchSpawn` (spawns the worker)
 * and `sendNightshiftOp` (the sentinel RPC) -- so we mock both and drive the
 * drain loop by hand via the exported `advanceAllRuns`. Covers: empty-queue skip,
 * the concurrency cap (never more than N in flight), the totalTasks cap (never
 * dispatch more than the cap), finalize after everything settles, and the
 * ensure-terminal patch for a worker that ends without reporting.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { expandPath } from '../sentinel/expand-path'
import type { NightshiftResult } from '../shared/protocol'
import type { SpawnRequest } from '../shared/spawn-schema'
import type { ConversationStore } from './conversation-store'
import type { NightshiftIo } from './nightshift-orchestrator'

// --- controllable doubles, closed over by the mocked modules below ---------

interface OpCall {
  op: string
  taskPatch?: { id: string; status?: string; note?: string }
  [k: string]: unknown
}

let opCalls: OpCall[] = []
let dispatchCount = 0
/** Every SpawnRequest the orchestrator handed to dispatchSpawn, verbatim. */
let spawnReqs: SpawnRequest[] = []
/** Queue the fake sentinel returns for `queue_list`. */
let queueItems: Array<{ id: string; title: string }> = []
/** Config the fake sentinel returns for `config_read`. */
let configOut: Record<string, unknown> = {}
/** Tasks the fake sentinel returns for `snapshot` (drives ensureTerminalArtifact). */
let snapshotTasks: Array<{ id: string; status: string }> = []
/** conversationId -> status, the fake store's view of spawned workers. */
const convStatus = new Map<string, string>()

const fakeDispatchSpawn = async (req: SpawnRequest) => {
  spawnReqs.push(req)
  dispatchCount += 1
  const conversationId = `conv-${dispatchCount}`
  convStatus.set(conversationId, 'active')
  return { ok: true as const, conversationId }
}

const fakeSendNightshiftOp = async (_deps: unknown, _project: string, op: OpCall): Promise<NightshiftResult> => {
  opCalls.push(op)
  const base = { type: 'nightshift_result' as const, requestId: '', op: op.op, ok: true }
  if (op.op === 'config_read') return { ...base, config: configOut } as unknown as NightshiftResult
  if (op.op === 'queue_list') return { ...base, queue: queueItems } as unknown as NightshiftResult
  if (op.op === 'snapshot') return { ...base, snapshot: { tasks: snapshotTasks } } as unknown as NightshiftResult
  return base as unknown as NightshiftResult
}

const {
  advanceAllRuns,
  configureCapacityAdmission,
  configureNightshiftIo,
  isNightshiftRunActive,
  resetNightshiftIo,
  runNightshift,
} = await import('./nightshift-orchestrator')

// The doubles go through the orchestrator's OWN io seam, not `mock.module`.
// bun's module mocks are process-wide and resolve before any test runs, so
// mocking './spawn-dispatch' here used to leak into every later test file in the
// suite -- 32 spawn tests saw a dispatchSpawn that reported success without ever
// reaching a sentinel. This keeps the substitution local to this file.
configureNightshiftIo({
  dispatchSpawn: fakeDispatchSpawn as unknown as NightshiftIo['dispatchSpawn'],
  sendNightshiftOp: fakeSendNightshiftOp as unknown as NightshiftIo['sendNightshiftOp'],
})
afterAll(resetNightshiftIo)
const { CapacityLedger } = await import('./capacity-ledger')

const store = {
  getConversation: (id: string) =>
    convStatus.has(id)
      ? { status: convStatus.get(id), stats: { totalInputTokens: 0, totalOutputTokens: 0 } }
      : undefined,
} as unknown as ConversationStore

/** A capacity ledger for the admission tests. `fiveHourPct` sets the stubbed
 *  oracle's 5h usage; a 1M-token window + 200k default estimate means 750k
 *  headroom at 0% admits exactly 3 tasks. */
function capacityLedger(enabled: boolean, fiveHourPct = 0): InstanceType<typeof CapacityLedger> {
  return new CapacityLedger({
    config: {
      enabled,
      windowTokenBudget: 1_000_000,
      defaultEstimateTokens: 200_000,
      floor: { baseFloorFraction: 0, morningRampMultiplier: 1, rampHours: 0 },
    },
    oracle: () => (enabled ? { fiveHourPct } : null),
    emit: () => {},
    now: () => 1_000,
  })
}

/** Mark every spawned worker as ended and (by default) cleanly settled in the snapshot. */
function endAllWorkers(status = 'done'): void {
  for (const id of convStatus.keys()) convStatus.set(id, 'ended')
  snapshotTasks = queueItems.map(q => ({ id: q.id, status }))
}

function makeQueue(n: number): Array<{ id: string; title: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: String(i + 1).padStart(3, '0'), title: `task ${i + 1}` }))
}

/** Step the run to completion (or until it stops making progress) and count steps. */
async function drainToFinalize(project: string, maxSteps = 20): Promise<number> {
  let steps = 0
  while (isNightshiftRunActive(project) && steps < maxSteps) {
    endAllWorkers()
    await advanceAllRuns(store)
    steps += 1
  }
  return steps
}

beforeEach(() => {
  opCalls = []
  dispatchCount = 0
  spawnReqs = []
  queueItems = []
  configOut = { enabled: true, permissionMode: 'dontAsk', caps: { concurrency: 2, totalTasks: 8 } }
  snapshotTasks = []
  convStatus.clear()
})

describe('runNightshift', () => {
  test('empty queue is skipped, nothing dispatched, no run opened', async () => {
    queueItems = []
    const out = await runNightshift(store, 'proj-empty', { trigger: 'manual' })
    expect(out.ok).toBe(false)
    expect(out.skipped).toMatch(/queue is empty/)
    expect(dispatchCount).toBe(0)
    expect(opCalls.some(o => o.op === 'run_start')).toBe(false)
    expect(isNightshiftRunActive('proj-empty')).toBe(false)
  })

  test('scheduler trigger respects config.enabled=false', async () => {
    configOut = { enabled: false, permissionMode: 'dontAsk' }
    queueItems = makeQueue(3)
    const out = await runNightshift(store, 'proj-disabled', { trigger: 'scheduler' })
    expect(out.ok).toBe(false)
    expect(out.skipped).toMatch(/not enabled/)
    expect(dispatchCount).toBe(0)
  })

  test('first wave dispatches up to the concurrency cap, not the whole queue', async () => {
    queueItems = makeQueue(5) // concurrency 2
    const out = await runNightshift(store, 'proj-conc', { trigger: 'manual' })
    expect(out.ok).toBe(true)
    expect(out.dispatched).toBe(2)
    expect(dispatchCount).toBe(2) // only 2 in flight, 3 still pending
    expect(isNightshiftRunActive('proj-conc')).toBe(true)
    await drainToFinalize('proj-conc') // clean up so the global tick doesn't bleed into later tests
  })

  test('drains the full queue two-at-a-time, then finalizes', async () => {
    queueItems = makeQueue(5)
    await runNightshift(store, 'proj-drain', { trigger: 'manual' })
    const steps = await drainToFinalize('proj-drain')
    expect(dispatchCount).toBe(5) // every task ran exactly once
    expect(steps).toBeGreaterThanOrEqual(2) // 5 tasks / 2 slots => multiple waves
    expect(isNightshiftRunActive('proj-drain')).toBe(false)
    expect(opCalls.some(o => o.op === 'run_finalize')).toBe(true)
  })

  test('totalTasks cap bounds dispatch below the queue length', async () => {
    queueItems = makeQueue(12) // totalTasks 8
    await runNightshift(store, 'proj-cap', { trigger: 'manual' })
    await drainToFinalize('proj-cap')
    expect(dispatchCount).toBe(8) // never dispatched the extra 4
    expect(isNightshiftRunActive('proj-cap')).toBe(false)
  })

  // REGRESSION (Phase F dispatch bug, 2026-06-26): the orchestrator passes the
  // project URI as `cwd` untouched (CWD-IS-INFORMATIONAL -- the broker never
  // resolves paths); the sentinel's expandPath seam is what turns it into a real
  // directory. Before ba3e70dd expandPath mangled the URI into
  // `/Users/jonas/claude:/default/...` and no worker ever spawned.
  test('dispatch shapes a spawnable request: URI cwd verbatim, resolvable by the sentinel seam', async () => {
    const project = 'claude://default/Users/jonas/projects/remote-claude'
    queueItems = makeQueue(1)
    const out = await runNightshift(store, project, { trigger: 'manual' })
    expect(out.ok).toBe(true)

    const req = spawnReqs[0]
    expect(req).toBeDefined()
    if (!req || !out.runId) throw new Error('no spawn request captured')
    expect(req.cwd).toBe(project) // the URI, byte-for-byte -- no broker-side path surgery
    expect(req.worktree).toBe(`nightshift/${out.runId}-001`)
    expect(req.headless).toBe(true)
    expect(req.nightshift).toEqual({ runId: out.runId, taskId: '001' })
    expect(req.permissionMode).toBe('dontAsk')

    // H7 finding 2: single-prompt workers are ad-hoc so they EXIT on completion
    // (tested end-of-turn shutdown) instead of idling until the watchdog reaps them.
    expect(req.adHoc).toBe(true)

    // H7 finding 1: the spawn carries the unattended settings the sentinel
    // materializes -- a default allowlist (dontAsk is otherwise dead) + the
    // always-on deny-floor. Broker passes opaque data; sentinel writes the file.
    const perms = (req.settingsInline as { permissions?: { allow?: string[]; deny?: string[] } } | undefined)
      ?.permissions
    expect(perms?.allow).toContain('Bash(bun test:*)')
    expect(perms?.allow).toContain('Bash(git commit:*)')
    expect(perms?.deny).toContain('Bash(git push origin main:*)')
    expect(perms?.allow).not.toContain('Bash(git push origin main:*)')

    // The other half of the seam: the sentinel resolves that exact cwd to the
    // project path, NOT a spawnRoot-relative mangle of the URI text.
    expect(expandPath(req.cwd as string, '/some/spawn/root')).toBe('/Users/jonas/projects/remote-claude')

    await drainToFinalize(project)
  })

  test('a worker that ends WITHOUT reporting is patched to errored', async () => {
    queueItems = makeQueue(1)
    await runNightshift(store, 'proj-stall', { trigger: 'manual' })
    // worker ends but the snapshot still shows it `running` (never self-reported)
    for (const id of convStatus.keys()) convStatus.set(id, 'ended')
    snapshotTasks = [{ id: '001', status: 'running' }]
    await advanceAllRuns(store)
    const patch = opCalls.find(o => o.op === 'task_patch' && o.taskPatch?.id === '001')
    expect(patch?.taskPatch?.status).toBe('errored')
    expect(patch?.taskPatch?.note).toMatch(/without reporting/)
    expect(isNightshiftRunActive('proj-stall')).toBe(false)
  })

  // H7 finding 3: a watchdog-capped worker is stamped terminal (errored) by the
  // watchdog BEFORE it terminates. When the orchestrator then reaps the ended
  // worker, ensureTerminalArtifact's guard must see the terminal status and NOT
  // add a second "without reporting" stamp -- exactly ONE terminal artifact.
  test('a worker already stamped errored (watchdog cap) is not double-stamped', async () => {
    queueItems = makeQueue(1)
    await runNightshift(store, 'proj-capped', { trigger: 'manual' })
    for (const id of convStatus.keys()) convStatus.set(id, 'ended')
    snapshotTasks = [{ id: '001', status: 'errored' }] // watchdog got here first
    await advanceAllRuns(store)
    const patches = opCalls.filter(o => o.op === 'task_patch' && o.taskPatch?.id === '001')
    expect(patches).toHaveLength(0) // guard skips -> no duplicate terminal artifact
    expect(isNightshiftRunActive('proj-capped')).toBe(false)
  })
})

/**
 * Capacity admission wired into the real dispatch path (§9). Proves the ledger
 * gates runNightshift: only what HEADROOM allows is dispatched; denied tasks stay
 * QUEUED, never errored. Verified with the stubbed spawn (end-to-end needs H1
 * merged -- see the H4 packet Verify note). Resets the ledger to disabled after
 * each case so no other test inherits an enabled ledger.
 */
describe('capacity admission', () => {
  afterEach(async () => {
    configureCapacityAdmission(capacityLedger(false))
    // drain any lingering capacity run so it doesn't bleed into later tests.
    for (const proj of ['proj-cap-admit', 'proj-cap-gated']) {
      for (let i = 0; i < 10 && isNightshiftRunActive(proj); i++) {
        for (const id of convStatus.keys()) convStatus.set(id, 'ended')
        snapshotTasks = queueItems.map(q => ({ id: q.id, status: 'done' }))
        await advanceAllRuns(store)
      }
    }
  })

  test('dispatches only what headroom admits; denied tasks stay QUEUED, not errored', async () => {
    configureCapacityAdmission(capacityLedger(true, 0)) // 750k headroom -> 3 * 200k fit
    // high concurrency so HEADROOM, not the concurrency cap, is the limiter.
    configOut = { enabled: true, permissionMode: 'dontAsk', caps: { concurrency: 8, totalTasks: 8 } }
    queueItems = makeQueue(5)
    const out = await runNightshift(store, 'proj-cap-admit', { trigger: 'manual' })
    expect(out.ok).toBe(true)
    expect(dispatchCount).toBe(3)
    // no denied task was errored
    expect(opCalls.some(o => o.op === 'task_patch' && o.taskPatch?.status === 'errored')).toBe(false)
    expect(isNightshiftRunActive('proj-cap-admit')).toBe(true) // holding the queued remainder
  })

  test('fully gated (no headroom) dispatches nothing but keeps the run alive', async () => {
    configureCapacityAdmission(capacityLedger(true, 99)) // ~0 headroom
    configOut = { enabled: true, permissionMode: 'dontAsk', caps: { concurrency: 8, totalTasks: 8 } }
    queueItems = makeQueue(5)
    const out = await runNightshift(store, 'proj-cap-gated', { trigger: 'manual' })
    expect(out.ok).toBe(true)
    expect(dispatchCount).toBe(0)
    expect(opCalls.some(o => o.op === 'task_patch' && o.taskPatch?.status === 'errored')).toBe(false)
    expect(isNightshiftRunActive('proj-cap-gated')).toBe(true)
  })
})
