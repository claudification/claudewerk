/**
 * NIGHTSHIFT GUARDIAN core (plan-quest-engine.md §2a / §6c / §6d) -- the shared
 * primitives the poke/crash settle logic (`nightshift-guardian-settle.ts`) and
 * the sweep loop (`nightshift-guardians.ts`) both build on: deps types, the
 * in-memory caches, the artifact reader, and the mechanical terminal-stamp.
 *
 * §14 recoverability: every cache here is exactly that -- a CACHE. The truth is
 * the card frontmatter + the conversation store; a broker restart re-derives it
 * all from the next sweep.
 */

import type { ServerWebSocket } from 'bun'
import type { Conversation, GuardianTerminalReason } from '../shared/protocol'
import type { ConversationStore } from './conversation-store'
import type { NightshiftRpcDeps } from './nightshift-broker-rpc'
import { sendNightshiftOp } from './nightshift-broker-rpc'
import {
  deliverPoke as defaultDeliverPoke,
  emitGuardianEvent,
  makeGuardianEvent,
  notifyTerminalError,
  respawnTask,
} from './nightshift-guardian-actions'
import { type CrashContext, type InvestigatorResult, investigateCrash } from './nightshift-investigator'

const MAX_POKES = 2
const POKE_BACKOFF_MS = 90_000
const ATTEMPT_CAP = 3

/** Card statuses that are NOT terminal -- the guardians only act on these. */
export const NON_TERMINAL = new Set(['queued', 'running', 'spinning'])

/** Identifiers for one nightshift task. */
export interface TaskIds {
  project: string
  runId: string
  taskId: string
}

/** The store surface the guardians need (structurally satisfied by ConversationStore). */
export interface GuardianStore extends NightshiftRpcDeps {
  getAllConversations: () => Conversation[]
  getActiveConversationCount: (id: string) => number
  getConversationSocket: (id: string) => ServerWebSocket<unknown> | undefined
  broadcastScoped: (msg: Record<string, unknown>, project: string) => void
}

/** The mechanical §6c notification payload. */
export interface GuardianNotify extends TaskIds {
  conversationId: string
  reason: GuardianTerminalReason
  detail: string
}

/** Injectable actions -- defaults bind to the real broker seams; tests stub them. */
export interface GuardianActions {
  now: () => number
  maxPokes: number
  pokeBackoffMs: number
  attemptCap: number
  investigate: (ctx: CrashContext) => Promise<InvestigatorResult>
  dispatchRetry: (ctx: CrashContext, nextAttempt: number, remedy?: string) => Promise<boolean>
  deliverPoke: (conv: Conversation) => boolean
  notify: (p: GuardianNotify) => void
  emit: (ev: ReturnType<typeof makeGuardianEvent>) => void
}

export type GuardianDeps = GuardianStore & GuardianActions

// ─── module-level caches (CACHE, not truth -- §14) ──────────────────────────
/** taskKey -> bounded-poke bookkeeping. */
export const pokeTracker = new Map<string, { count: number; lastAt: number }>()
/** taskKeys with an async settle in flight -- reentrancy guard. */
export const inflightSettle = new Set<string>()

export const keyOf = (t: TaskIds): string => `${t.project}::${t.runId}::${t.taskId}`

/** Test-only: clear the guardian's in-memory caches between cases. */
export function __resetGuardianStateForTest(): void {
  pokeTracker.clear()
  inflightSettle.clear()
}

/** Fill store methods + default actions bound to `store`, then apply overrides. */
export function buildGuardianDeps(store: ConversationStore, overrides: Partial<GuardianDeps> = {}): GuardianDeps {
  const s = store as unknown as GuardianStore
  const base: GuardianDeps = {
    getAllConversations: s.getAllConversations,
    getActiveConversationCount: s.getActiveConversationCount,
    getConversationSocket: s.getConversationSocket,
    getSentinel: s.getSentinel,
    getSentinelByAlias: s.getSentinelByAlias,
    addProjectListener: s.addProjectListener,
    removeProjectListener: s.removeProjectListener,
    broadcastScoped: s.broadcastScoped,
    now: Date.now,
    maxPokes: MAX_POKES,
    pokeBackoffMs: POKE_BACKOFF_MS,
    attemptCap: ATTEMPT_CAP,
    investigate: ctx => investigateCrash(store, ctx),
    dispatchRetry: (ctx, nextAttempt, remedy) => respawnTask(store, ctx, nextAttempt, remedy),
    deliverPoke: conv => defaultDeliverPoke(s, conv),
    notify: notifyTerminalError,
    emit: ev => emitGuardianEvent(s.broadcastScoped, ev),
  }
  return { ...base, ...overrides }
}

/** True if the conversation exited abnormally (crash), not a clean/intentional end. */
export function isCrashEnd(conv: Conversation): boolean {
  return conv.endedBy?.source === 'cc-exit-crash'
}

/** Read one task's current frontmatter (status + attempts) from the artifact tree. */
export async function readTask(deps: GuardianDeps, ids: TaskIds): Promise<{ status: string; attempts: number } | null> {
  const snap = await sendNightshiftOp(deps, ids.project, { op: 'snapshot', runId: ids.runId })
  const task = snap.snapshot?.tasks.find(t => t.id === ids.taskId)
  if (!task) return null
  return { status: task.status, attempts: task.attempts ?? 0 }
}

/** Mechanically stamp a task terminal-errored + fire the §6c notify (NO LLM). */
export async function stampTerminal(
  deps: GuardianDeps,
  ids: TaskIds,
  conv: Conversation,
  reason: GuardianTerminalReason,
  detail: string,
): Promise<void> {
  await sendNightshiftOp(deps, ids.project, {
    op: 'task_patch',
    runId: ids.runId,
    taskPatch: { id: ids.taskId, status: 'errored', note: `${reason}: ${detail}` },
  })
  deps.emit(
    makeGuardianEvent(deps.now(), {
      kind: 'terminal-error',
      project: ids.project,
      runId: ids.runId,
      taskId: ids.taskId,
      conversationId: conv.id,
      profile: conv.resolvedProfile,
      terminalReason: reason,
      reason: detail,
    }),
  )
  deps.notify({ ...ids, conversationId: conv.id, reason, detail })
  pokeTracker.delete(keyOf(ids))
}
