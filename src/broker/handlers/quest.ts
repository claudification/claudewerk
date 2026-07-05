/**
 * Quest substrate relay: dashboard / agent-leg <-> sentinel.
 *
 * The quest manifest tree (`<project>/.rclaude/project/quests/<petname>/`) is
 * read + written THROUGH THE SENTINEL (the lease-watcher host that owns the
 * project's files), so quest state works with zero running conversations --
 * exactly like the project board + nightshift. The caller sends a project URI;
 * the broker resolves it to an absolute `projectRoot` + owning sentinel,
 * forwards `quest_op`, and relays `quest_result` back. After a successful WRITE
 * op the broker fans a `quest_event` beat to every control panel viewing that
 * project (EVERYTHING IS A STRUCTURED MESSAGE).
 *
 * Boundary: never touches ccSessionId. projectRoot comes from the trusted
 * project URI; the sentinel jails every path under it (quest-store.ts). §14: the
 * broker holds NO quest state -- it is a pure relay.
 */

import { parseProjectUri } from '../../shared/project-uri'
import type { QuestEvent, QuestOp, QuestOpKind, QuestRequest, QuestResult } from '../../shared/protocol'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { CONTROL_PANEL_ONLY, registerHandlers, SENTINEL_ONLY } from '../message-router'

const QUEST_RPC_TIMEOUT_MS = 10_000
// WRITE_OPS + resolveTarget mirror the nightshift/project relay handlers by design.
// fallow-ignore-next-line code-duplication
const WRITE_OPS = new Set<QuestOpKind>(['create', 'update', 'log_append', 'abort', 'pause'])

/** Resolve a project URI to its host root + owning sentinel socket. */
function resolveTarget(ctx: HandlerContext, project: string) {
  const parsed = parseProjectUri(project)
  const sentinel =
    (parsed.authority ? ctx.conversations.getSentinelByAlias(parsed.authority) : undefined) ?? ctx.getSentinel()
  return { projectRoot: parsed.path, sentinel }
}

/** Which write ops fan a beat, and under what event name (STRATEGY MAP -- read
 *  ops omitted). */
const EVENT_BY_OP: Partial<Record<QuestOpKind, QuestEvent['event']>> = {
  create: 'created',
  update: 'updated',
  log_append: 'log',
  abort: 'aborted',
  pause: 'paused',
}

/** Map a successful write result to its broadcast beat (null = no beat). */
function beatFor(d: QuestRequest, result: QuestResult): QuestEvent | null {
  const event = result.ok ? EVENT_BY_OP[d.op] : undefined
  const petname = result.manifest?.petname ?? d.petname ?? ''
  if (!event || !petname) return null
  return { type: 'quest_event', project: d.project, event, petname, status: result.manifest?.status }
}

// Dashboard / agent-leg -> broker: one quest substrate op.
const questRequest: MessageHandler = (ctx, data) => {
  // fallow-ignore-next-line code-duplication
  const d = data as QuestRequest
  if (!d.project || !d.requestId || !d.op) return

  // Reads need files:read; writes need files. Throws GuardError on denial.
  ctx.requirePermission(WRITE_OPS.has(d.op) ? 'files' : 'files:read', d.project)

  const replyWs = ctx.ws
  const sendReply = (msg: Record<string, unknown>) => {
    try {
      replyWs.send(JSON.stringify(msg))
    } catch {
      /* socket gone -- caller navigated away */
    }
  }

  const { projectRoot, sentinel } = resolveTarget(ctx, d.project)
  if (!sentinel) {
    sendReply({
      type: 'quest_result',
      requestId: d.requestId,
      op: d.op,
      ok: false,
      error: 'no sentinel connected for project',
    })
    return
  }

  const timeout = setTimeout(() => {
    ctx.conversations.removeProjectListener(d.requestId)
    sendReply({ type: 'quest_result', requestId: d.requestId, op: d.op, ok: false, error: 'sentinel timed out (10s)' })
  }, QUEST_RPC_TIMEOUT_MS)

  ctx.conversations.addProjectListener(d.requestId, result => {
    clearTimeout(timeout)
    // fallow-ignore-next-line code-duplication
    const r = result as QuestResult
    sendReply(r as unknown as Record<string, unknown>)
    // Fan a lifecycle beat to everyone viewing this project (permission-scoped).
    const beat = beatFor(d, r)
    if (beat) ctx.broadcastScoped(beat as unknown as MessageData, d.project)
  })

  const op: QuestOp = {
    type: 'quest_op',
    requestId: d.requestId,
    projectRoot,
    op: d.op,
    petname: d.petname,
    create: d.create,
    patch: d.patch,
    logAppend: d.logAppend,
    reason: d.reason,
  }
  try {
    sentinel.send(JSON.stringify(op))
  } catch {
    clearTimeout(timeout)
    ctx.conversations.removeProjectListener(d.requestId)
    sendReply({ type: 'quest_result', requestId: d.requestId, op: d.op, ok: false, error: 'sentinel send failed' })
  }
}

// Sentinel -> broker: RPC result -> resolve the pending listener (replies to caller).
const questResult: MessageHandler = (ctx, data: MessageData) => {
  if (data.requestId) ctx.conversations.resolveProject(data.requestId as string, data)
}

export function registerQuestHandlers(): void {
  // Reading/writing the quest tree exposes the project's on-disk files --
  // restricted to the authenticated control panel + benevolent agents. Share-link
  // guests are rejected by the router (CONTROL_PANEL_ONLY excludes 'share').
  registerHandlers({ quest_request: questRequest }, CONTROL_PANEL_ONLY)
  registerHandlers({ quest_result: questResult }, SENTINEL_ONLY)
}
