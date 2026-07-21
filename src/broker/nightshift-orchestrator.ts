/**
 * NIGHTSHIFT orchestrator -- the Night Run engine (plan-nightshift.md §2.4 EVENTS tier).
 *
 * Turns a project's queued tasks into actual work: opens a run, dispatches guarded
 * headless workers into isolated worktrees (capped by concurrency + total), and
 * drains the queue as workers finish, then finalizes the run. The deterministic
 * WATCHDOG (nightshift-watchdog.ts) already caps each tagged worker (time/token/
 * idle/turn); the unattended SAFE-TO-DO preamble auto-rides every nightshift spawn
 * (spawn-dispatch.ts). This module is just the dispatch loop + completion tracking.
 *
 * Workers self-report their outcome via the `nightshift` MCP tool (writeTask
 * overwrites the running placeholder this orchestrator seeds). A worker that ends
 * WITHOUT reporting is patched to `errored` so every task lands terminal (failure
 * mode #4: no silent stalls).
 */

import {
  DEFAULT_NIGHTSHIFT_CONFIG,
  type NightshiftCaps,
  type NightshiftConfig,
  type NightshiftQueueItem,
  type NightshiftReportInput,
} from '../shared/nightshift-types'
import type { Conversation } from '../shared/protocol'
import type { SpawnCallerContext } from '../shared/spawn-permissions'
import { buildUnattendedSettings } from '../shared/unattended-permissions'
import { fillSlotsWithAdmission, taskRefOf } from './capacity-admission'
import { CapacityLedger } from './capacity-ledger'
import { DEFAULT_CAPACITY_CONFIG } from './capacity-types'
import type { ConversationStore } from './conversation-store'
import { getGlobalSettings } from './global-settings'
import { sendNightshiftOp } from './nightshift-broker-rpc'
import { settleWorkerFromStore } from './nightshift-guardians'
import { computeWindowEndMs } from './nightshift-window'
import { getProjectSettings } from './project-settings'
import { dispatchSpawn } from './spawn-dispatch'

/** How often the engine advances in-flight runs (reaps finished workers, dispatches next). */
const ORCH_TICK_MS = 20_000

/**
 * The capacity admission ledger (plan-quest-engine §9). A default DISABLED ledger
 * keeps today's pure-concurrency behaviour until the broker wires a real oracle
 * via `configureCapacityAdmission` at startup. When disabled, `fillSlots` ignores
 * it entirely -- no gating, no reservations.
 */
let ledger = new CapacityLedger({
  config: { ...DEFAULT_CAPACITY_CONFIG, enabled: false },
  oracle: () => null,
  emit: () => {},
})

/** Install the real capacity ledger (oracle + emit wired to the store). Called
 *  once at broker startup (index.ts) BEFORE the orchestrator tick begins. */
export function configureCapacityAdmission(next: CapacityLedger): void {
  ledger = next
}

/**
 * The two side-effecting calls this orchestrator makes -- spawning a worker and
 * talking to the sentinel -- behind a swappable seam.
 *
 * This exists so tests can substitute them WITHOUT `mock.module`. Bun's module
 * mocks are process-wide and are resolved before any test runs, so a module mock
 * here silently leaked the doubles into every later test file in the run: 32
 * spawn tests elsewhere saw a dispatchSpawn that reports success without ever
 * reaching a sentinel. Same shape as configureCapacityAdmission above.
 */
export interface NightshiftIo {
  dispatchSpawn: typeof dispatchSpawn
  sendNightshiftOp: typeof sendNightshiftOp
}

const REAL_IO: NightshiftIo = { dispatchSpawn, sendNightshiftOp }
let io: NightshiftIo = REAL_IO

/** Swap the IO seam (tests only). Call `resetNightshiftIo()` when done. */
export function configureNightshiftIo(next: Partial<NightshiftIo>): void {
  io = { ...REAL_IO, ...next }
}

/** Restore the real spawn/sentinel calls. */
export function resetNightshiftIo(): void {
  io = REAL_IO
}

/** Trusted, autonomous caller -- same shape the dispatcher uses for broker-internal spawns. */
const NIGHTSHIFT_CALLER: SpawnCallerContext = {
  kind: 'mcp',
  hasSpawnPermission: true,
  trustLevel: 'trusted',
  callerProject: null,
}

interface RunState {
  project: string
  runId: string
  /** Queued tasks not yet dispatched. */
  pending: NightshiftQueueItem[]
  /** taskId -> spawned conversationId, for the tasks currently running. */
  inflight: Map<string, string>
  permissionMode: NightshiftConfig['permissionMode']
  /** Inline settings the sentinel materializes for every worker this run: the
   *  dontAsk allowlist + always-on deny-floor (§6a). Computed once at run open. */
  settingsInline: Record<string, unknown>
  concurrency: number
  startedAt: number
  /** Reentrancy guard so the tick never double-advances a run. */
  advancing: boolean
  /** Profiles the balanced picker may place workers on (capacity admission §9). */
  candidateProfiles: string[]
  /** Epoch ms the run window closes -- drives the time-aware floor + starvation
   *  terminal (§9c/§9f). Undefined when the project has no clock window. */
  windowEndMs?: number
  /** Computed-sleep gate: while `now < sleepUntilMs` the run parks (§9d). */
  sleepUntilMs?: number
}

/** One in-flight run per project (a project can't run two nights at once). */
const activeRuns = new Map<string, RunState>()

export interface RunNightshiftOutcome {
  ok: boolean
  runId?: string
  dispatched?: number
  /** A non-error reason the run did nothing (empty queue / not enabled / already running). */
  skipped?: string
  error?: string
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function resolveCaps(caps?: NightshiftCaps): { concurrency: number; totalTasks: number } {
  const d = DEFAULT_NIGHTSHIFT_CONFIG.caps ?? {}
  return {
    concurrency: Math.max(1, caps?.concurrency ?? d.concurrency ?? 2),
    totalTasks: Math.max(1, caps?.totalTasks ?? d.totalTasks ?? 8),
  }
}

/** The placeholder artifact seeded at dispatch so the task shows as running immediately. */
function runningReport(item: NightshiftQueueItem, project: string): NightshiftReportInput {
  return {
    kind: 'task',
    id: item.id,
    title: item.title,
    project,
    status: 'running',
    verdict: 'needs-you',
    feasibility: item.feasibility ?? 'feasible',
    acceptance: item.acceptance,
    risk: item.risk,
  }
}

function taskPrompt(item: NightshiftQueueItem, runId: string, project: string): string {
  return [
    `You are NIGHTSHIFT task ${item.id} of run ${runId} (project: ${project}). You run UNATTENDED.`,
    `Title: ${item.title}`,
    item.body?.trim() || '',
    item.acceptance ? `## Acceptance\n${item.acceptance}` : '',
    '## How to work',
    `You are in an isolated git worktree on branch \`nightshift/${runId}-${item.id}\`. Do the work and commit to THIS branch only -- never merge or push to main.`,
    `When finished, report via the \`nightshift\` MCP tool: action=report, run_id=${runId}, id=${item.id}, with status (done|errored), verdict (ready-to-review|needs-you), branch, diffstat, tests (pass|fail|none), and a one-paragraph recap.`,
    'If you hit a blocker you cannot resolve with safe tools inside your worktree, report kind=blocked with a crisp question instead -- never guess or invent a workaround.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Seed the running artifact, remove from the queue, and spawn the guarded worker. */
async function dispatchTask(store: ConversationStore, state: RunState, item: NightshiftQueueItem): Promise<void> {
  const { runId, project } = state
  await io.sendNightshiftOp(store, project, { op: 'report', runId, report: runningReport(item, project) })
  await io.sendNightshiftOp(store, project, { op: 'dequeue', dequeueId: item.id })

  const res = await io.dispatchSpawn(
    {
      cwd: project,
      prompt: taskPrompt(item, runId, project),
      headless: true,
      // Fire-and-forget single-prompt worker: exit on completion instead of
      // idling until the watchdog idle-cap reaps it (H7 finding 2). adHoc drives
      // the tested end-of-turn shutdown (headless-lifecycle: isAdHoc && !leaveRunning).
      adHoc: true,
      worktree: `nightshift/${runId}-${item.id}`,
      permissionMode: state.permissionMode,
      // Unattended allowlist + deny-floor, materialized sentinel-side (§6a).
      settingsInline: state.settingsInline,
      nightshift: { runId, taskId: item.id },
      name: `[ns ${runId}] ${item.title}`.slice(0, 80),
    },
    {
      conversationStore: store,
      getProjectSettings,
      getGlobalSettings,
      callerContext: NIGHTSHIFT_CALLER,
      rendezvousCallerConversationId: null,
      // Autonomous: a run must never stall on a human approval dialog.
      bypassApprovalGate: true,
    },
  )

  if (res.ok) {
    state.inflight.set(item.id, res.conversationId)
    console.log(
      `[nightshift-orch] dispatched task=${item.id} conv=${res.conversationId.slice(0, 8)} run=${runId} project=${project}`,
    )
  } else {
    // Spawn failed after we reserved capacity for it -- release the reservation
    // so the estimate doesn't sit on the profile's books forever (no-op when
    // admission was disabled and nothing was reserved).
    ledger.settle(taskRefOf(runId, item.id))
    await io.sendNightshiftOp(store, project, {
      op: 'task_patch',
      runId,
      taskPatch: { id: item.id, status: 'errored', note: `spawn failed: ${res.error}` },
    })
    console.warn(`[nightshift-orch] spawn failed task=${item.id} run=${runId}: ${res.error}`)
  }
}

/** Stamp a task SKIPPED(capacity) in the run report when the window closes with
 *  it never admitted (§9f). Structured message, not silence. */
async function stampSkipped(
  store: ConversationStore,
  state: RunState,
  item: NightshiftQueueItem,
  reason: string,
): Promise<void> {
  await io.sendNightshiftOp(store, state.project, {
    op: 'report',
    runId: state.runId,
    report: {
      kind: 'skipped',
      id: item.id,
      title: item.title,
      project: state.project,
      reason,
      feasibility: item.feasibility ?? 'feasible',
    },
  })
  console.log(`[nightshift-orch] task=${item.id} SKIPPED(capacity) run=${state.runId}: ${reason}`)
}

/**
 * A worker ended without a terminal card. A CRASH (cc-exit-crash) with attempts
 * left is handed to the GUARDIAN, which triages it against the hint catalog and
 * retries-with-remedy or stamps terminal (§6d) -- EXTEND, don't duplicate. A
 * clean end that simply never reported is stamped errored right here (no silent
 * stalls). `conv` is the ended conversation from the reap (undefined if already
 * pruned from the store).
 */
async function ensureTerminalArtifact(
  store: ConversationStore,
  state: RunState,
  taskId: string,
  conv: Conversation | undefined,
): Promise<void> {
  const snap = await io.sendNightshiftOp(store, state.project, { op: 'snapshot', runId: state.runId })
  const task = snap.snapshot?.tasks.find(t => t.id === taskId)
  const unsettled = !task || task.status === 'running' || task.status === 'queued' || task.status === 'spinning'
  if (!unsettled) return

  if (conv?.endedBy?.source === 'cc-exit-crash') {
    // Crash: let the guardian investigate before any terminal verdict (§6d).
    await settleWorkerFromStore(store, { project: state.project, runId: state.runId, taskId }, conv)
    return
  }
  await io.sendNightshiftOp(store, state.project, {
    op: 'task_patch',
    runId: state.runId,
    taskPatch: { id: taskId, status: 'errored', note: 'worker ended without reporting an outcome' },
  })
}

/** Reap workers that have ended: drop them from inflight + ensure a terminal
 *  artifact + SETTLE their capacity reservation with the actual token spend. */
async function reapFinished(store: ConversationStore, state: RunState): Promise<void> {
  for (const [taskId, convId] of [...state.inflight]) {
    const conv = store.getConversation(convId)
    if (conv && conv.status !== 'ended') continue
    state.inflight.delete(taskId)
    // Settle the reservation to actual usage (the real figure is already in the
    // oracle's used%; this releases the estimate + logs the delta). No-op when
    // admission was disabled at dispatch.
    const actual = conv ? conv.stats.totalInputTokens + conv.stats.totalOutputTokens : undefined
    ledger.settle(taskRefOf(state.runId, taskId), actual)
    await ensureTerminalArtifact(store, state, taskId, conv)
    console.log(`[nightshift-orch] task=${taskId} settled run=${state.runId} inflight=${state.inflight.size}`)
  }
}

/** Fill open concurrency slots from the pending queue. With capacity admission
 *  ENABLED, gate every dispatch on headroom (§9); otherwise fall back to the
 *  pure-concurrency drain (today's behaviour). */
async function fillSlots(store: ConversationStore, state: RunState): Promise<void> {
  if (!ledger.enabled) return fillSlotsLegacy(store, state)
  await fillSlotsWithAdmission(ledger, state, {
    dispatch: item => dispatchTask(store, state, item),
    starveCard: (item, reason) => stampSkipped(store, state, item, reason),
  })
}

/** Pure-concurrency drain (capacity admission disabled). */
async function fillSlotsLegacy(store: ConversationStore, state: RunState): Promise<void> {
  while (state.inflight.size < state.concurrency && state.pending.length > 0) {
    const next = state.pending.shift()
    if (next) await dispatchTask(store, state, next)
  }
}

/** Finalize + retire the run once nothing is pending and nothing is in flight. */
async function maybeFinalize(store: ConversationStore, state: RunState): Promise<void> {
  if (state.pending.length > 0 || state.inflight.size > 0) return
  const runtimeMin = Math.round((Date.now() - state.startedAt) / 60_000)
  await io.sendNightshiftOp(store, state.project, {
    op: 'run_finalize',
    runId: state.runId,
    finalize: { runtime_min: runtimeMin },
  })
  activeRuns.delete(state.project)
  console.log(`[nightshift-orch] run=${state.runId} FINALIZED project=${state.project} runtime=${runtimeMin}m`)
}

/** Reap finished workers, fill open slots from the queue, finalize when fully drained. */
async function advanceRun(store: ConversationStore, state: RunState): Promise<void> {
  if (state.advancing) return
  state.advancing = true
  try {
    await reapFinished(store, state)
    await fillSlots(store, state)
    await maybeFinalize(store, state)
  } finally {
    state.advancing = false
  }
}

/**
 * Open a nightshift run for a project: read config + queue, start the run, dispatch
 * the first wave of workers. The tick (startNightshiftOrchestrator) drains the rest.
 * `trigger: 'scheduler'` respects `config.enabled`; `'manual'` (Run-now) ignores it.
 */
export async function runNightshift(
  store: ConversationStore,
  project: string,
  opts: { trigger: 'manual' | 'scheduler' },
): Promise<RunNightshiftOutcome> {
  if (activeRuns.has(project)) return { ok: false, skipped: 'a nightshift run is already in flight for this project' }

  const cfgRes = await io.sendNightshiftOp(store, project, { op: 'config_read' })
  const config = (cfgRes.config ?? DEFAULT_NIGHTSHIFT_CONFIG) as NightshiftConfig
  if (opts.trigger === 'scheduler' && !config.enabled)
    return { ok: false, skipped: 'nightshift not enabled for project' }

  const qRes = await io.sendNightshiftOp(store, project, { op: 'queue_list' })
  if (!qRes.ok) return { ok: false, error: qRes.error ?? 'queue read failed' }
  const queue = (qRes.queue ?? []) as NightshiftQueueItem[]
  if (queue.length === 0) return { ok: false, skipped: 'queue is empty' }

  const caps = resolveCaps(config.caps)
  const tasks = queue.slice(0, caps.totalTasks)
  const runId = todayStr()
  const startedAt = Date.now()
  const startRes = await io.sendNightshiftOp(store, project, {
    op: 'run_start',
    runStart: { runId, taskCount: tasks.length, window: config.window },
  })
  if (!startRes.ok) return { ok: false, error: startRes.error ?? 'run_start failed' }

  const state: RunState = {
    project,
    runId,
    pending: [...tasks],
    inflight: new Map(),
    permissionMode: config.permissionMode,
    // Allowlist + deny-floor materialized per worker (§6a / plan-nightshift §10).
    // Applies in every mode -- the deny-floor bites even under bypass; the
    // allowlist is what makes dontAsk usable at all.
    settingsInline: buildUnattendedSettings({ allow: config.allow, deny: config.deny }),
    concurrency: caps.concurrency,
    startedAt,
    advancing: false,
    // Capacity admission (§9): which profiles the workers may land on, and when
    // the run window closes (for the time-aware floor + starvation terminal).
    candidateProfiles: config.profilesAllowed?.length ? config.profilesAllowed : ['default'],
    windowEndMs: computeWindowEndMs(config.window, startedAt),
  }
  activeRuns.set(project, state)
  console.log(
    `[nightshift-orch] run=${runId} START project=${project} trigger=${opts.trigger} tasks=${tasks.length} concurrency=${caps.concurrency} mode=${config.permissionMode}`,
  )
  await advanceRun(store, state)
  return { ok: true, runId, dispatched: state.inflight.size }
}

/** True if a run is currently in flight for the project (used by the scheduler). */
export function isNightshiftRunActive(project: string): boolean {
  return activeRuns.has(project)
}

/**
 * EVENT-TRIGGERED RECHECK (§9d): a `rate_limit_event` folded fresh utilisation
 * telemetry (headroom may have moved). Clear the computed-sleep gate on every
 * parked run and advance immediately, so recovered capacity is used the moment
 * it appears -- no polling loop beyond the existing tick. Called from the
 * transcript rate-limit handler; a no-op when nothing is parked.
 */
export function noteCapacityUsageEvent(store: ConversationStore): void {
  let woke = 0
  for (const state of activeRuns.values()) {
    if (state.sleepUntilMs !== undefined) {
      state.sleepUntilMs = undefined
      woke++
    }
  }
  if (woke === 0) return
  console.log(`[nightshift-orch] capacity usage event -- woke ${woke} parked run(s), re-checking admission`)
  void advanceAllRuns(store)
}

/** Advance every in-flight run once -- the tick body, exported so tests can step it. */
export async function advanceAllRuns(store: ConversationStore): Promise<void> {
  for (const state of [...activeRuns.values()]) {
    await advanceRun(store, state).catch(err =>
      console.error(`[nightshift-orch] advance crashed run=${state.runId}:`, err),
    )
  }
}

/** Start the engine tick: every ORCH_TICK_MS, advance every in-flight run. */
export function startNightshiftOrchestrator(store: ConversationStore): { stop: () => void } {
  const id = setInterval(() => {
    void advanceAllRuns(store)
  }, ORCH_TICK_MS)
  return { stop: () => clearInterval(id) }
}
