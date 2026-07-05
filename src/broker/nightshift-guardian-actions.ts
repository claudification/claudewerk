/**
 * Default guardian ACTIONS (plan-quest-engine.md §2a / §6c / §6d). The policy
 * loop (`nightshift-guardians.ts`) decides WHAT to do; this module is the HOW,
 * bound to the real broker seams. Every action here is injectable/overridable in
 * that module so the policy is unit-tested without a live sentinel or CC.
 */

import { randomUUID } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import type { Conversation, GuardianEvent, GuardianTerminalReason, NightshiftGuardianEvent } from '../shared/protocol'
import type { SpawnCallerContext } from '../shared/spawn-permissions'
import { buildReviveMessage } from './build-revive'
import type { ConversationStore } from './conversation-store'
import { getGlobalSettings } from './global-settings'
import { recordGuardianEvent } from './nightshift-guardian-log'
import type { CrashContext } from './nightshift-investigator'
import { getProjectSettings } from './project-settings'
import { isPushConfigured, sendPushToAll } from './push'
import { dispatchSpawn } from './spawn-dispatch'

const GUARDIAN_CALLER: SpawnCallerContext = {
  kind: 'mcp',
  hasSpawnPermission: true,
  trustLevel: 'trusted',
  callerProject: null,
}

/** The prod delivered to a dead/stalled worker -- terminal-status-or-bust. */
const POKE_PROMPT =
  'You appear stalled with your task card still non-terminal. You MUST end with a terminal status: report what you did via the `nightshift` MCP tool (status done|errored, or kind=blocked with a crisp question) and finish. Do not start new work.'

/** The socket surface a poke/revive needs, satisfied structurally by ConversationStore. */
export interface PokeStore {
  getConversationSocket: (id: string) => ServerWebSocket<unknown> | undefined
  getSentinel: () => ServerWebSocket<unknown> | undefined
  getSentinelByAlias: (alias: string) => ServerWebSocket<unknown> | undefined
}

/**
 * Deliver one poke via EXISTING mechanics. A live-but-stalled worker gets an
 * `inter_session_message` prod (the send_message path); a dead worker is revived
 * through its owning sentinel (the channel_revive path), carrying its nightshift
 * tag forward so the guardians keep tracking the resumed leg. Returns whether a
 * delivery was actually issued. Never throws -- a dead socket just returns false
 * (the bounded-poke counter still advances; the mechanical stamp is the backstop).
 */
export function deliverPoke(store: PokeStore, conv: Conversation): boolean {
  const socket = store.getConversationSocket(conv.id)
  if (socket) {
    try {
      socket.send(
        JSON.stringify({
          type: 'inter_session_message',
          from: 'nightshift-guardian',
          message: POKE_PROMPT,
          intent: 'request',
        }),
      )
      return true
    } catch {
      return false
    }
  }
  // Dead worker: revive through the owning sentinel (alias-routed when known).
  const sentinel =
    (conv.hostSentinelId ? store.getSentinelByAlias(conv.hostSentinelId) : undefined) ?? store.getSentinel()
  if (!sentinel) return false
  try {
    const revive = buildReviveMessage(conv, randomUUID()) as unknown as Record<string, unknown>
    // Preserve the nightshift origin tag across revive so watchdog + guardians
    // keep tracking the resumed leg (buildReviveMessage does not carry it).
    if (conv.launchConfig?.nightshift) revive.nightshift = conv.launchConfig.nightshift
    sentinel.send(JSON.stringify(revive))
    return true
  } catch {
    return false
  }
}

/** Assemble the crash triage context from an ended conversation. Paths ride as
 *  opaque passthrough (CWD IS INFORMATIONAL -- never broker logic). */
export function buildCrashContext(
  conv: Conversation,
  meta: { runId: string; taskId: string; attempts: number; attemptCap: number },
): CrashContext {
  const detail = conv.endedBy?.detail
  const signature = [conv.lastError?.errorMessage, conv.lastError?.stopReason, detail?.note].filter(Boolean).join(' | ')
  return {
    project: conv.project,
    runId: meta.runId,
    taskId: meta.taskId,
    conversationId: conv.id,
    profile: conv.resolvedProfile,
    exitCode: detail?.ccExitCode,
    exitNote: detail?.note,
    transcriptTail: signature || undefined,
    cwd: conv.currentPath,
    // The nightshift worker's branch is derived from its tag; ad-hoc convs carry
    // an explicit branch. Opaque passthrough context only (never broker logic).
    worktree: conv.adHocWorktree ?? `nightshift/${meta.runId}-${meta.taskId}`,
    attempts: meta.attempts,
    attemptCap: meta.attemptCap,
  }
}

/** Re-dispatch a fresh worker for a crashed-but-retryable task. Always respawns
 *  at the PROJECT ROOT on a fresh per-attempt branch -- the universally-safe
 *  remedy (a removed worktree cannot be resumed). Returns spawn success. */
export async function respawnTask(
  store: ConversationStore,
  ctx: CrashContext,
  nextAttempt: number,
  remedy?: string,
): Promise<boolean> {
  const prompt = [
    `You are NIGHTSHIFT task ${ctx.taskId} of run ${ctx.runId} (project: ${ctx.project}). You run UNATTENDED. This is a RETRY (attempt ${nextAttempt}) after a prior leg crashed.`,
    remedy ? `Investigator remedy: ${remedy}` : '',
    `Read the task's card + branch under \`.nightshift/\` to see prior progress, continue the work, and commit to your worktree branch only -- never merge or push to main.`,
    `When finished, report via the \`nightshift\` MCP tool (status done|errored, verdict, branch, diffstat, tests, recap), or kind=blocked with a crisp question.`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const res = await dispatchSpawn(
    {
      cwd: ctx.project,
      prompt,
      headless: true,
      worktree: `nightshift/${ctx.runId}-${ctx.taskId}-r${nextAttempt}`,
      permissionMode: 'dontAsk',
      nightshift: { runId: ctx.runId, taskId: ctx.taskId },
      name: `[ns retry ${nextAttempt}] ${ctx.taskId}`.slice(0, 80),
    },
    {
      conversationStore: store,
      getProjectSettings,
      getGlobalSettings,
      callerContext: GUARDIAN_CALLER,
      rendezvousCallerConversationId: null,
      bypassApprovalGate: true,
    },
  )
  if (!res.ok) console.warn(`[nightshift-guardian] retry respawn failed task=${ctx.taskId}: ${res.error}`)
  return res.ok
}

/** The mechanical §6c notification -- NO LLM in this path. Fired as a RULE on the
 *  typed transition to a terminal-error state. Best-effort (returns early if push
 *  is unconfigured); includes ids + reason so the phone push is self-explanatory. */
export function notifyTerminalError(payload: {
  project: string
  runId: string
  taskId: string
  conversationId: string
  reason: GuardianTerminalReason
  detail: string
}): void {
  if (!isPushConfigured()) return
  const label: Record<GuardianTerminalReason, string> = {
    unresponsive: 'Night task unresponsive',
    'crash-fatal': 'Night task crashed (fatal)',
    'cap-hit': 'Night task hit retry cap',
  }
  sendPushToAll({
    title: label[payload.reason],
    body: `run ${payload.runId} task ${payload.taskId}: ${payload.detail}`,
    project: payload.project,
    conversationId: payload.conversationId,
    tag: `ns-guardian-${payload.runId}-${payload.taskId}`,
  }).catch(() => {})
}

/** Record a guardian event to the ring + broadcast it project-scoped (EVERYTHING
 *  IS A STRUCTURED MESSAGE). Also mirrors a one-line log (LOG EVERYTHING). */
export function emitGuardianEvent(
  broadcastScoped: (msg: Record<string, unknown>, project: string) => void,
  ev: GuardianEvent,
): void {
  recordGuardianEvent(ev)
  const wire: NightshiftGuardianEvent = { type: 'nightshift_guardian_event', project: ev.project, event: ev }
  broadcastScoped(wire as unknown as Record<string, unknown>, ev.project)
  console.log(
    `[nightshift-guardian] ${ev.kind} task=${ev.taskId} run=${ev.runId} conv=${ev.conversationId.slice(0, 8)}` +
      `${ev.attempt !== undefined ? ` attempt=${ev.attempt}` : ''}${ev.cap !== undefined ? `/${ev.cap}` : ''}` +
      `${ev.verdict ? ` verdict=${ev.verdict}` : ''}${ev.terminalReason ? ` terminal=${ev.terminalReason}` : ''} -- ${ev.reason}`,
  )
}

/** Build a GuardianEvent with a fresh id + timestamp (the flat wire record). */
export function makeGuardianEvent(at: number, fields: Omit<GuardianEvent, 'id' | 'at'>): GuardianEvent {
  return { id: `gd-${randomUUID()}`, at, ...fields }
}
