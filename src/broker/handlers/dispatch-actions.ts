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
 *   dispatch_list_threads  -> listThreadsForUser   -> dispatch_list_threads_result
 */

import { runDispatchAgent } from '../desk/agent-runtime'
import { dumpUserHistory } from '../desk/history-store'
import { readMemory } from '../desk/memory'
import type { DispatchCommand } from '../desk/orchestrate'
import { type DispatchRuntime, listDispatchRosterCandidates, runDispatch } from '../desk/runtime'
import { workspaceSnapshot } from '../desk/workspace'
import { GuardError, type HandlerContext, type MessageData, type MessageHandler } from '../handler-context'
import { CONTROL_PANEL_ONLY, registerHandlers } from '../message-router'

// fallow-ignore-next-line complexity
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

/** Run the agent loop, streaming each tool call + result to the requesting
 *  overlay (rendered dimmed) under one shared traceId. */
function runAgentTurn(
  ctx: HandlerContext,
  intent: string,
  rt: DispatchRuntime,
  opts: { model?: string; userId: string | null; requestId?: string; confirmedExpensive?: boolean },
) {
  const { userId, requestId } = opts
  const traceId = `trc_${crypto.randomUUID()}`
  return runDispatchAgent(intent, rt, {
    model: opts.model,
    traceId,
    userId,
    confirmedExpensive: opts.confirmedExpensive ?? false,
    onToolCall: e =>
      ctx.reply({
        type: 'dispatch_tool_call',
        requestId,
        traceId,
        userId,
        callId: e.callId,
        name: e.name,
        summary: e.summary,
        args: e.args,
        ts: Date.now(),
      }),
    onToolResult: e =>
      ctx.reply({
        type: 'dispatch_tool_result',
        requestId,
        traceId,
        userId,
        callId: e.callId,
        ok: e.ok,
        summary: e.summary,
        result: e.result,
        error: e.error,
        ts: Date.now(),
      }),
  })
}

/** Resolve a command to a decision. Explicit disposition/target (candidate-pick,
 *  confirm-expensive) keep the deterministic override path; a free-text intent
 *  drives the AGENT LOOP (the dispatcher is a controller, tool calls stream out). */
function resolveDecision(
  ctx: HandlerContext,
  data: MessageData,
  cmd: DispatchCommand,
  rt: DispatchRuntime,
  userId: string | null,
  requestId?: string,
) {
  if (cmd.disposition || cmd.target) return runDispatch(cmd, rt)
  const model = typeof data.model === 'string' && data.model ? data.model : undefined
  // The user confirming an expensive action re-issues the intent with this flag;
  // it un-bypasses the cost gate for the whole impulse (B5).
  return runAgentTurn(ctx, cmd.intent, rt, { model, userId, requestId, confirmedExpensive: cmd.confirmedExpensive })
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

  const rt: DispatchRuntime = {
    store: ctx.conversations,
    callerConversationId: null,
    // B5: let the dispatcher search transcripts itself (the cheap expert path).
    searchTranscripts: (query, limit) =>
      ctx.store.transcripts.search(query, { limit }).map(h => ({
        conversationId: h.conversationId,
        seq: h.seq,
        type: h.type,
        snippet: h.snippet,
      })),
  }
  try {
    const decision = await resolveDecision(ctx, data, cmd, rt, userId, requestId)
    // Stamp the per-user owner on the correlated reply (read-layer scoping).
    ctx.reply({ type: 'dispatch_request_result', requestId, ok: true, decision: { ...decision, userId } })
    ctx.log.debug(`dispatch_request [${userId ?? 'anon'}] "${cmd.intent.slice(0, 40)}" -> ${decision.disposition}`)
  } catch (e) {
    ctx.reply({ type: 'dispatch_request_result', requestId, ok: false, error: (e as Error).message })
    ctx.log.debug(`dispatch_request [${userId ?? 'anon'}] refused: ${(e as Error).message}`)
  }
}

// Loads the GLOBAL dispatcher's desk state on overlay-open: the live roster
// ("active right now"), durable memory, scratch workspaces, and the living
// history. The dispatcher fronts ALL projects -- there is no per-project view --
// and THREADS are short-term memory folded into the dispatcher's context, not a
// surfaced panel, so neither is sent to the overlay.
const dispatchListThreads: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  ctx.requirePermission('spawn')
  const requestId = typeof data.requestId === 'string' ? data.requestId : undefined
  const userId = ctx.ws.data.userName ?? null
  const roster = listDispatchRosterCandidates(ctx.conversations)
  const memory = readMemory(userId)
  const workspaces = workspaceSnapshot()
  // The living conversation itself (transcript + state blocks) so opening the
  // overlay loads the persistent dispatcher, not a blank feed (Slice C).
  const history = dumpUserHistory(userId)
  // Conventional `${request}_result` name (see DispatchThreadsResult): a thrown
  // dispatchListThreads (permission gate) is auto-replied by the router as
  // `dispatch_list_threads_result` ok:false, which must reach the same client
  // handler -- else the overlay wedges on "loading" forever.
  ctx.reply({ type: 'dispatch_list_threads_result', requestId, roster, memory, workspaces, history, userId })
}

export function registerDispatchHandlers(): void {
  // Control panel only -- share (guest) viewers must not drive the dispatcher.
  registerHandlers(
    { dispatch_request: dispatchRequest, dispatch_list_threads: dispatchListThreads },
    CONTROL_PANEL_ONLY,
  )
}
