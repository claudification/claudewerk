/**
 * Nightshift artifact relay: dashboard / night-manager <-> sentinel.
 *
 * The `.nightshift/` morning report is read + written THROUGH THE SENTINEL (the
 * lease-watcher host that owns the project's files), so the Result screen works
 * with zero running conversations -- exactly like the project board. The caller
 * sends a project URI; the broker resolves it to an absolute `projectRoot` + the
 * owning sentinel, forwards the `nightshift_op`, and relays `nightshift_result`
 * back to the requesting socket. After a successful WRITE op the broker fans a
 * `nightshift_event` beat to every control panel viewing that project so the
 * Result screen can refresh.
 *
 * Boundary: never touches ccSessionId. projectRoot comes from the trusted
 * project URI; the sentinel jails every path under it (nightshift-store.ts).
 */

import { parseProjectUri } from '../../shared/project-uri'
import type {
  NightshiftEvent,
  NightshiftOp,
  NightshiftOpKind,
  NightshiftRequest,
  NightshiftResult,
} from '../../shared/protocol'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { CONTROL_PANEL_ONLY, registerHandlers, SENTINEL_ONLY } from '../message-router'

const NIGHTSHIFT_RPC_TIMEOUT_MS = 10_000
const WRITE_OPS = new Set<NightshiftOpKind>(['config_write', 'run_start', 'report', 'task_patch', 'run_finalize'])

/** Resolve a project URI to its host root + owning sentinel socket. */
function resolveTarget(ctx: HandlerContext, project: string) {
  const parsed = parseProjectUri(project)
  const sentinel =
    (parsed.authority ? ctx.conversations.getSentinelByAlias(parsed.authority) : undefined) ?? ctx.getSentinel()
  return { projectRoot: parsed.path, sentinel }
}

/** Map a successful write result to its broadcast beat (null = no beat). */
function beatFor(d: NightshiftRequest, result: NightshiftResult): NightshiftEvent | null {
  if (!result.ok) return null
  const runId = result.run?.runId ?? d.runId ?? d.runStart?.runId ?? d.report?.id ?? ''
  switch (d.op) {
    case 'run_start':
      return { type: 'nightshift_event', project: d.project, event: 'run_started', runId, digest: result.run?.digest }
    case 'run_finalize':
      return { type: 'nightshift_event', project: d.project, event: 'run_done', runId, digest: result.run?.digest }
    case 'task_patch':
      // ACT-ON-RESULTS patched a task in place -> nudge the Result screen to refetch.
      return {
        type: 'nightshift_event',
        project: d.project,
        event: 'task_update',
        runId,
        taskId: d.taskPatch?.id,
        status: result.task?.status,
        verdict: result.task?.verdict,
      }
    case 'report': {
      const kind = d.report?.kind
      const event = kind === 'blocked' ? 'blocked' : 'task_done'
      return {
        type: 'nightshift_event',
        project: d.project,
        event,
        runId,
        taskId: d.report?.id,
        status: result.task?.status,
        verdict: result.task?.verdict,
      }
    }
    default:
      return null
  }
}

// Dashboard / night-manager -> broker: one nightshift artifact op.
const nightshiftRequest: MessageHandler = (ctx, data) => {
  const d = data as NightshiftRequest
  if (!d.project || !d.requestId || !d.op) return

  // Reads need files:read; writes need files. Throws GuardError on denial.
  ctx.requirePermission(WRITE_OPS.has(d.op) ? 'files' : 'files:read', d.project)

  const { projectRoot, sentinel } = resolveTarget(ctx, d.project)
  const replyWs = ctx.ws
  const sendReply = (msg: Record<string, unknown>) => {
    try {
      replyWs.send(JSON.stringify(msg))
    } catch {
      /* socket gone -- caller navigated away */
    }
  }

  if (!sentinel) {
    sendReply({
      type: 'nightshift_result',
      requestId: d.requestId,
      op: d.op,
      ok: false,
      error: 'no sentinel connected for project',
    })
    return
  }

  const timeout = setTimeout(() => {
    ctx.conversations.removeProjectListener(d.requestId)
    sendReply({
      type: 'nightshift_result',
      requestId: d.requestId,
      op: d.op,
      ok: false,
      error: 'sentinel timed out (10s)',
    })
  }, NIGHTSHIFT_RPC_TIMEOUT_MS)

  ctx.conversations.addProjectListener(d.requestId, result => {
    clearTimeout(timeout)
    const r = result as NightshiftResult
    sendReply(r as unknown as Record<string, unknown>)
    // Fan a lifecycle beat to everyone viewing this project (permission-scoped).
    const beat = beatFor(d, r)
    if (beat) ctx.broadcastScoped(beat as unknown as MessageData, d.project)
  })

  const op: NightshiftOp = {
    type: 'nightshift_op',
    requestId: d.requestId,
    projectRoot,
    op: d.op,
    runId: d.runId,
    config: d.config,
    runStart: d.runStart,
    report: d.report,
    taskPatch: d.taskPatch,
    finalize: d.finalize,
  }
  try {
    sentinel.send(JSON.stringify(op))
  } catch {
    clearTimeout(timeout)
    ctx.conversations.removeProjectListener(d.requestId)
    sendReply({ type: 'nightshift_result', requestId: d.requestId, op: d.op, ok: false, error: 'sentinel send failed' })
  }
}

// Sentinel -> broker: RPC result -> resolve the pending listener (replies to caller).
const nightshiftResult: MessageHandler = (ctx, data: MessageData) => {
  if (data.requestId) ctx.conversations.resolveProject(data.requestId as string, data)
}

export function registerNightshiftHandlers(): void {
  // Reading/writing the morning report exposes the project's on-disk tree --
  // restricted to the authenticated control panel + benevolent agents. Share-link
  // guests are rejected by the router (CONTROL_PANEL_ONLY excludes 'share').
  registerHandlers({ nightshift_request: nightshiftRequest }, CONTROL_PANEL_ONLY)
  registerHandlers({ nightshift_result: nightshiftResult }, SENTINEL_ONLY)
}
