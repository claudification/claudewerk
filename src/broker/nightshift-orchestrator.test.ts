/**
 * Nightshift orchestrator drain tests. The orchestrator talks to the outside
 * world through exactly three module deps -- `dispatchSpawn` (spawns the
 * worker), `sendNightshiftOp` (the sentinel RPC) and `callBoard` (the project
 * board, which is where the run's TASKS come from since the copy-queue was
 * retired) -- so we mock all three and drive the drain loop by hand via the
 * exported `advanceAllRuns`. Covers: nothing-tagged skip, the concurrency cap
 * (never more than N in flight), the totalTasks cap (never dispatch more than
 * the cap), finalize after everything settles, the DRAIN that replaced the
 * dequeue (the tag comes off on the task's verdict, never on the dispatch), and
 * the ensure-terminal patch for a worker that ends without reporting.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { expandPath } from '../sentinel/expand-path'
import { NIGHTSHIFT_TAG } from '../shared/nightshift-types'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { NightshiftResult } from '../shared/protocol'
import type { SpawnRequest } from '../shared/spawn-schema'
import type { BoardRpcResult } from './board-rpc'
import type { ConversationStore } from './conversation-store'
import type { NightshiftIo } from './nightshift-orchestrator'

// --- controllable doubles, closed over by the mocked modules below ---------

interface OpCall {
  op: string
  taskPatch?: { id: string; status?: string; note?: string }
  [k: string]: unknown
}

let opCalls: OpCall[] = []
/** Every board op the orchestrator sent -- the list, the per-card reads, and
 *  the tag-stripping update that replaced `dequeue`. */
let boardCalls: Array<{ op: string; slug?: string; tags?: string[] }> = []
let dispatchCount = 0
/** Every SpawnRequest the orchestrator handed to dispatchSpawn, verbatim. */
let spawnReqs: SpawnRequest[] = []
/** The `#nightshift` cards the fake board answers `list` with. One per task the
 *  run should open with -- `queueItems[i]` and card `i` are the same work. */
let queueItems: Array<{ id: string; title: string }> = []
/** Config the fake sentinel returns for `config_read`. */
let configOut: Record<string, unknown> = {}
/** Tasks the fake sentinel returns for `snapshot` (drives ensureTerminalArtifact). */
let snapshotTasks: Array<{ id: string; status: string }> = []
/** conversationId -> status, the fake store's view of spawned workers. */
const convStatus = new Map<string, string>()
/** Is the `nightshift` scanner ticked for the project under test? ON for every
 *  case but the gate's own -- these tests are about what a run DOES once it is
 *  authorised, and the authorisation has its own case below. */
let scannerOn = true
/** Every `scannersLastRun` stamp the orchestrator wrote, in order. */
let stamps: Array<{ project: string; at: number }> = []
/** Make the fake board THROW rather than answer, so the scan comes back
 *  `crashed` -- the one pass outcome that must not be stamped. */
let boardThrows = false

/** The board card behind `queueItems[i]`. Slugs sort in the same order as the
 *  ordinals, so the scanner numbers them 001..N in this order. */
function cardOf(item: { id: string; title: string }): ProjectTaskMeta {
  return {
    slug: `card-${item.id}`,
    status: 'open',
    title: item.title,
    tags: [NIGHTSHIFT_TAG],
    refs: [],
    created: '2026-08-01T00:00:00Z',
    mtime: 0,
    bodyPreview: '',
  }
}

const fakeDispatchSpawn = async (req: SpawnRequest) => {
  spawnReqs.push(req)
  dispatchCount += 1
  const conversationId = `conv-${dispatchCount}`
  convStatus.set(conversationId, 'active')
  return { ok: true as const, conversationId }
}

const fakeCallBoard = async (
  _store: unknown,
  _project: string,
  op: { op: string; slug?: string; patch?: { tags?: string[] } },
): Promise<BoardRpcResult> => {
  boardCalls.push({ op: op.op, slug: op.slug, tags: op.patch?.tags })
  if (boardThrows) throw new Error('sentinel exploded')
  if (op.op === 'list') return { ok: true, tasks: queueItems.map(cardOf) }
  if (op.op === 'get') {
    const item = queueItems.find(q => `card-${q.id}` === op.slug)
    return { ok: true, task: item ? { ...cardOf(item), body: `body of ${op.slug}` } : null }
  }
  return { ok: true }
}

const fakeSendNightshiftOp = async (_deps: unknown, _project: string, op: OpCall): Promise<NightshiftResult> => {
  opCalls.push(op)
  const base = { type: 'nightshift_result' as const, requestId: '', op: op.op, ok: true }
  if (op.op === 'config_read') return { ...base, config: configOut } as unknown as NightshiftResult
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
  callBoard: fakeCallBoard as unknown as NightshiftIo['callBoard'],
  // The fabric's per-project opt-in, on the same seam and for the same reason:
  // a run opens here without a settings store behind it.
  scannerOptIn: {
    projects: () => [],
    enabled: () => scannerOn,
    stamp: (project, at) => stamps.push({ project, at }),
  },
})
afterAll(resetNightshiftIo)
const { CapacityLedger } = await import('./capacity-ledger')

const store = {
  getConversation: (id: string) =>
    convStatus.has(id)
      ? { status: convStatus.get(id), stats: { totalInputTokens: 0, totalOutputTokens: 0 } }
      : undefined,
  // The board scan folds the registry to find cards a live conversation is
  // already on. No epic seats here, so nothing is ever held back for liveness.
  getAllConversations: () => [],
  getActiveConversationCount: () => 0,
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
  boardCalls = []
  dispatchCount = 0
  spawnReqs = []
  queueItems = []
  configOut = { enabled: true, permissionMode: 'dontAsk', caps: { concurrency: 2, totalTasks: 8 } }
  snapshotTasks = []
  convStatus.clear()
  scannerOn = true
  stamps = []
  boardThrows = false
})

/**
 * THE FABRIC'S GATE AND STAMP, which `nightshift` sat outside of until
 * `werk-scanner-clock`. It had a caller and no opt-in and no stamp, so its row in
 * Project Settings read `last ran never` forever while it was in fact running --
 * the amber column lying in the one direction nobody checks.
 */
describe('the nightshift scanner is gated and stamped by its caller', () => {
  test('a project with the box off is refused BEFORE the config read or the board', async () => {
    scannerOn = false
    queueItems = makeQueue(2)
    const out = await runNightshift(store, 'proj-off', { trigger: 'scheduler' })
    expect(out.ok).toBe(false)
    expect(out.skipped).toMatch(/"nightshift" scanner is off/)
    // NOTHING was spent: no sentinel RPC, no board read, no worker.
    expect(opCalls).toEqual([])
    expect(boardCalls).toEqual([])
    expect(dispatchCount).toBe(0)
    expect(stamps).toEqual([])
  })

  // Run-now dispatches the identical fleet the scheduler does, so honouring it
  // for an opted-out project would be a back door around a default-deny gate --
  // the reasoning `beatOneEpic` already gives for refusing BEAT NOW.
  test('a MANUAL run is refused too -- Run now is not a back door around the opt-in', async () => {
    scannerOn = false
    queueItems = makeQueue(2)
    const out = await runNightshift(store, 'proj-off-manual', { trigger: 'manual' })
    expect(out.ok).toBe(false)
    expect(out.skipped).toMatch(/Project Settings > Scanners/)
    expect(dispatchCount).toBe(0)
  })

  test('a completed pass stamps the project, even when it admitted nothing', async () => {
    queueItems = []
    const out = await runNightshift(store, 'proj-quiet', { trigger: 'scheduler' })
    // The RUN did not open -- nothing was tagged -- but the PASS happened, and
    // that is the distinction the stamp exists to draw. Without it the row says
    // `never` for a loop that is alive and simply has nothing to do.
    expect(out.ok).toBe(false)
    expect(stamps.map(s => s.project)).toEqual(['proj-quiet'])
  })

  test('a pass that opened a run stamps exactly once', async () => {
    queueItems = makeQueue(1)
    const out = await runNightshift(store, 'proj-stamped', { trigger: 'manual' })
    expect(out.ok).toBe(true)
    expect(stamps.map(s => s.project)).toEqual(['proj-stamped'])
    await drainToFinalize('proj-stamped')
  })

  test('a scan that CRASHED does not stamp -- a failed pass is not a pass', async () => {
    queueItems = makeQueue(1)
    // The board THROWS rather than answering `{ok:false}`. `runScan` catches it
    // and reports `crashed`, which is the one outcome the stamp must not follow:
    // stamping here would say the loop swept a project it never read.
    boardThrows = true
    const out = await runNightshift(store, 'proj-crash', { trigger: 'manual' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/board scan failed/)
    expect(stamps).toEqual([])
  })
})

describe('runNightshift', () => {
  test('a board with nothing tagged is skipped, nothing dispatched, no run opened', async () => {
    queueItems = []
    const out = await runNightshift(store, 'proj-empty', { trigger: 'manual' })
    expect(out.ok).toBe(false)
    expect(out.skipped).toMatch(/no cards tagged #nightshift/)
    expect(dispatchCount).toBe(0)
    expect(opCalls.some(o => o.op === 'run_start')).toBe(false)
    expect(isNightshiftRunActive('proj-empty')).toBe(false)
  })

  // THE POINT OF THE CARD: the run's input is a reference to a card, not a copy
  // of one. The prompt has to carry the body the board holds RIGHT NOW.
  test('the task body is read from the card at dispatch, never from a stored copy', async () => {
    queueItems = makeQueue(1)
    const out = await runNightshift(store, 'proj-ref', { trigger: 'manual' })
    expect(out.ok).toBe(true)
    expect(boardCalls.filter(c => c.op === 'get').map(c => c.slug)).toContain('card-001')
    expect(spawnReqs[0]?.prompt).toContain('body of card-001')
    await drainToFinalize('proj-ref')
  })

  /**
   * DISPATCHING IS NOT THE DEQUEUE ANY MORE.
   *
   * It was, twice over: `op: 'dequeue'` against `.nightshift/queue/`, then
   * stripping `#nightshift` the moment the worker was spawned. Both cleared the
   * queue entry on the work STARTING, so a crashed worker left the card untagged
   * and unworked with nothing on the board to say so. The tag now comes off on
   * the task's verdict -- see the two cases below.
   */
  test('dispatch touches no tag, and never dequeues a copy', async () => {
    queueItems = makeQueue(1)
    await runNightshift(store, 'proj-untag', { trigger: 'manual' })

    expect(boardCalls.some(c => c.op === 'update')).toBe(false)
    expect(opCalls.some(o => o.op === 'dequeue')).toBe(false)
    await drainToFinalize('proj-untag')
  })

  test('a task that reached `done` drops #nightshift from its card', async () => {
    queueItems = makeQueue(1)
    await runNightshift(store, 'proj-landed', { trigger: 'manual' })
    await drainToFinalize('proj-landed')

    const update = boardCalls.find(c => c.op === 'update')
    expect(update?.slug).toBe('card-001')
    expect(update?.tags).toEqual([])
  })

  /**
   * THE CARD. A worker that crashed leaves `#nightshift` ON, so the card is still
   * on the board, still visible, and on tomorrow night's list. Clearing it would
   * be silent scope loss: the work never happened and nothing would say so.
   */
  test('a task that ERRORED leaves #nightshift on its card', async () => {
    queueItems = makeQueue(1)
    await runNightshift(store, 'proj-crashed', { trigger: 'manual' })
    // The worker ends, and its artifact is terminal-but-failed.
    for (const id of convStatus.keys()) convStatus.set(id, 'ended')
    snapshotTasks = [{ id: '001', status: 'errored' }]
    await advanceAllRuns(store)

    expect(boardCalls.some(c => c.op === 'update')).toBe(false)
  })

  /** A worker that ended without reporting anything at all is the same answer:
   *  `ensureTerminalArtifact` stamps it errored, and no evidence means no clear. */
  test('a worker that never reported leaves #nightshift on its card', async () => {
    queueItems = makeQueue(1)
    await runNightshift(store, 'proj-silent', { trigger: 'manual' })
    for (const id of convStatus.keys()) convStatus.set(id, 'ended')
    snapshotTasks = []
    await advanceAllRuns(store)

    expect(opCalls.some(o => o.op === 'task_patch' && o.taskPatch?.status === 'errored')).toBe(true)
    expect(boardCalls.some(c => c.op === 'update')).toBe(false)
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
