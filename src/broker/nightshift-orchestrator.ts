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
import type { ConversationStore } from './conversation-store'
import { getGlobalSettings } from './global-settings'
import { sendNightshiftOp } from './nightshift-broker-rpc'
import { settleWorkerFromStore } from './nightshift-guardians'
import { getProjectSettings } from './project-settings'
import { dispatchSpawn } from './spawn-dispatch'

/** How often the engine advances in-flight runs (reaps finished workers, dispatches next). */
const ORCH_TICK_MS = 20_000

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
  concurrency: number
  startedAt: number
  /** Reentrancy guard so the tick never double-advances a run. */
  advancing: boolean
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
  await sendNightshiftOp(store, project, { op: 'report', runId, report: runningReport(item, project) })
  await sendNightshiftOp(store, project, { op: 'dequeue', dequeueId: item.id })

  const res = await dispatchSpawn(
    {
      cwd: project,
      prompt: taskPrompt(item, runId, project),
      headless: true,
      worktree: `nightshift/${runId}-${item.id}`,
      permissionMode: state.permissionMode,
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
    await sendNightshiftOp(store, project, {
      op: 'task_patch',
      runId,
      taskPatch: { id: item.id, status: 'errored', note: `spawn failed: ${res.error}` },
    })
    console.warn(`[nightshift-orch] spawn failed task=${item.id} run=${runId}: ${res.error}`)
  }
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
  const snap = await sendNightshiftOp(store, state.project, { op: 'snapshot', runId: state.runId })
  const task = snap.snapshot?.tasks.find(t => t.id === taskId)
  const unsettled = !task || task.status === 'running' || task.status === 'queued' || task.status === 'spinning'
  if (!unsettled) return

  if (conv?.endedBy?.source === 'cc-exit-crash') {
    // Crash: let the guardian investigate before any terminal verdict (§6d).
    await settleWorkerFromStore(store, { project: state.project, runId: state.runId, taskId }, conv)
    return
  }
  await sendNightshiftOp(store, state.project, {
    op: 'task_patch',
    runId: state.runId,
    taskPatch: { id: taskId, status: 'errored', note: 'worker ended without reporting an outcome' },
  })
}

/** Reap workers that have ended: drop them from inflight + ensure a terminal artifact. */
async function reapFinished(store: ConversationStore, state: RunState): Promise<void> {
  for (const [taskId, convId] of [...state.inflight]) {
    const conv = store.getConversation(convId)
    if (conv && conv.status !== 'ended') continue
    state.inflight.delete(taskId)
    await ensureTerminalArtifact(store, state, taskId, conv)
    console.log(`[nightshift-orch] task=${taskId} settled run=${state.runId} inflight=${state.inflight.size}`)
  }
}

/** Fill open concurrency slots from the pending queue. */
async function fillSlots(store: ConversationStore, state: RunState): Promise<void> {
  while (state.inflight.size < state.concurrency && state.pending.length > 0) {
    const next = state.pending.shift()
    if (next) await dispatchTask(store, state, next)
  }
}

/** Finalize + retire the run once nothing is pending and nothing is in flight. */
async function maybeFinalize(store: ConversationStore, state: RunState): Promise<void> {
  if (state.pending.length > 0 || state.inflight.size > 0) return
  const runtimeMin = Math.round((Date.now() - state.startedAt) / 60_000)
  await sendNightshiftOp(store, state.project, {
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

  const cfgRes = await sendNightshiftOp(store, project, { op: 'config_read' })
  const config = (cfgRes.config ?? DEFAULT_NIGHTSHIFT_CONFIG) as NightshiftConfig
  if (opts.trigger === 'scheduler' && !config.enabled)
    return { ok: false, skipped: 'nightshift not enabled for project' }

  const qRes = await sendNightshiftOp(store, project, { op: 'queue_list' })
  if (!qRes.ok) return { ok: false, error: qRes.error ?? 'queue read failed' }
  const queue = (qRes.queue ?? []) as NightshiftQueueItem[]
  if (queue.length === 0) return { ok: false, skipped: 'queue is empty' }

  const caps = resolveCaps(config.caps)
  const tasks = queue.slice(0, caps.totalTasks)
  const runId = todayStr()
  const startRes = await sendNightshiftOp(store, project, {
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
    concurrency: caps.concurrency,
    startedAt: Date.now(),
    advancing: false,
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
