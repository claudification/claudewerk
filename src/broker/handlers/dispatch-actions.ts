/**
 * Dispatch overlay WS seam: lets a control-panel client drive the Front Desk
 * dispatcher (the `desk/*` backend) over the dashboard WebSocket.
 *
 * The `dispatch` / `list_threads` MCP tools are reachable only by agent-host /
 * chat-api callers and carry NO authed-user identity (just callerConversationId).
 * The per-user dispatch overlay is a control-panel client, and a control-panel WS
 * connection DOES carry the authed user (ws.data.userName). So this is the clean
 * chokepoint to scope the dispatcher per user.
 *
 * Thin pass-through by design: transport + auth + correlation here, decision +
 * store logic stays in desk/ (runDispatch / listThreads). Zero logic duplicated.
 *
 *   dispatch_request       -> runDispatch(cmd, rt) -> dispatch_request_result (+ broadcast DispatchDecision)
 *   dispatch_list_threads  -> listThreadsForUser   -> dispatch_threads_result
 */

import type { DispatchCommand } from '../desk/orchestrate'
import { type DispatchRuntime, listDispatchRosterCandidates, runDispatch } from '../desk/runtime'
import { listThreads } from '../desk/threads'
import { GuardError, type HandlerContext, type MessageData, type MessageHandler } from '../handler-context'
import { CONTROL_PANEL_ONLY, registerHandlers } from '../message-router'

/**
 * Per-user read seam for the dispatcher near-memory. The threads store has no
 * `user_id` column yet (single-user reality), so today every thread is the one
 * user's and this returns them all. When the backend per-user increment lands
 * (`listThreads({ userId })` + a `user_id` column), this becomes the ONE place
 * to pass the authed user through -- the overlay already scopes on `userId`.
 */
function listThreadsForUser(_userId: string | null, limit?: number) {
  return listThreads(limit ?? undefined)
}

function buildCommand(data: MessageData): DispatchCommand {
  const intent = typeof data.intent === 'string' ? data.intent.trim() : ''
  if (!intent) throw new GuardError('dispatch_request requires a non-empty intent')
  const cmd: DispatchCommand = { intent }
  if (typeof data.target === 'string' && data.target) cmd.target = data.target
  if (data.disposition === 'new' || data.disposition === 'route' || data.disposition === 'revive') {
    cmd.disposition = data.disposition
  }
  if (data.confirmedExpensive === true) cmd.confirmedExpensive = true
  if (typeof data.cwd === 'string' && data.cwd) cmd.cwd = data.cwd
  if (typeof data.worktreeName === 'string' && data.worktreeName) cmd.worktreeName = data.worktreeName
  if (typeof data.project === 'string' && data.project) cmd.project = data.project
  if (typeof data.profile === 'string' && data.profile) cmd.profile = data.profile
  return cmd
}

const dispatchRequest: MessageHandler = async (ctx: HandlerContext, data: MessageData) => {
  // Dispatch can spawn/route/revive -- gate on the `spawn` permission (global).
  ctx.requirePermission('spawn')
  const requestId = typeof data.requestId === 'string' ? data.requestId : undefined
  const userId = ctx.ws.data.userName ?? null

  let cmd: DispatchCommand
  try {
    cmd = buildCommand(data)
  } catch (e) {
    ctx.reply({ type: 'dispatch_request_result', requestId, ok: false, error: (e as Error).message })
    return
  }

  const rt: DispatchRuntime = { store: ctx.conversations, callerConversationId: null }
  try {
    const decision = await runDispatch(cmd, rt)
    // Stamp the per-user owner on the correlated reply (read-layer scoping).
    ctx.reply({ type: 'dispatch_request_result', requestId, ok: true, decision: { ...decision, userId } })
    ctx.log.debug(
      `dispatch_request [${userId ?? 'anon'}] "${cmd.intent.slice(0, 50)}" -> ` +
        `${decision.disposition}${decision.executed ? ' (executed)' : ''}`,
    )
  } catch (e) {
    ctx.reply({ type: 'dispatch_request_result', requestId, ok: false, error: (e as Error).message })
    ctx.log.debug(`dispatch_request [${userId ?? 'anon'}] refused: ${(e as Error).message}`)
  }
}

const dispatchListThreads: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  ctx.requirePermission('spawn')
  const requestId = typeof data.requestId === 'string' ? data.requestId : undefined
  const limit = typeof data.limit === 'number' && data.limit > 0 ? data.limit : undefined
  const userId = ctx.ws.data.userName ?? null
  const threads = listThreadsForUser(userId, limit)
  const roster = listDispatchRosterCandidates(ctx.conversations)
  ctx.reply({ type: 'dispatch_threads_result', requestId, threads, roster, userId })
}

export function registerDispatchHandlers(): void {
  // Control panel only -- share (guest) viewers must not drive the dispatcher.
  registerHandlers(
    { dispatch_request: dispatchRequest, dispatch_list_threads: dispatchListThreads },
    CONTROL_PANEL_ONLY,
  )
}
