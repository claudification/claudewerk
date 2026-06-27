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

import type { DispatchDecision, DispatchProjectStatus } from '../../shared/protocol'
import { runDispatchAgent } from '../desk/agent-runtime'
import { projectOverviewRows } from '../desk/dispatch-tools'
import { compactNow, dumpUserHistory, forgetUserMemory, maintainOnOpen, resetUserHistory } from '../desk/history-store'
import {
  readMemory,
  readMemoryRaw,
  readSystemAppend,
  refineMemory,
  writeMemory,
  writeSystemAppend,
} from '../desk/memory'
import type { DispatchCommand } from '../desk/orchestrate'
import type { ProjectOverviewRow } from '../desk/overview'
import { type DispatchRuntime, listDispatchRosterCandidates, runDispatch } from '../desk/runtime'
import { workspaceSnapshot } from '../desk/workspace'
import { GuardError, type HandlerContext, type MessageData, type MessageHandler } from '../handler-context'
import { CONTROL_PANEL_ONLY, registerHandlers } from '../message-router'
import { chat } from '../recap/shared/openrouter-client'
import { buildSotuView, projectSlug } from '../sotu'

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
/** Fold the SOTU read model (Phase 5) into a status row -- the real narrative
 *  UPGRADING the zero-LLM headline, plus the free floor (git alerts + the CONTENDED
 *  count). Pure render off the current chronicle + live queue (no forced regen on
 *  this hot UI path -- the activity trigger + spawn/MCP reads keep it fresh). Any
 *  failure (store not ready) degrades silently to the zero-LLM headline. */
function sotuEnrich(row: DispatchProjectStatus, projectUri: string, now: number): void {
  try {
    const view = buildSotuView({ slug: projectSlug(projectUri), project: projectUri, enabled: true, now })
    const narrative = view.chronicle.narrative.trim()
    if (narrative) row.sotuNarrative = narrative.slice(0, 280)
    if (view.alerts.length) row.sotuAlerts = view.alerts
    const contended = view.holds.filter(h => h.contended).length
    if (contended > 0) row.sotuContended = contended
  } catch {
    // SOTU store not initialized / unreadable -- keep the floor headline.
  }
}

/** Project STATUS strip: the attention-ordered overview, slimmed to a headline +
 *  counts, then ENRICHED with the SOTU narrative + git alerts + CONTENDED badge
 *  (Phase 5 -- the dispatcher tie-in that upgrades the zero-LLM strip into the real
 *  briefing). Projects with no live conv AND no brief are dropped; top rows only. */
function toStatusRows(rows: ProjectOverviewRow[]): DispatchProjectStatus[] {
  const now = Date.now()
  return rows
    .filter(r => r.live > 0 || r.brief.trim())
    .slice(0, 6)
    .map(r => {
      const headline = (r.brief.split('\n').find(l => l.trim()) ?? '').replace(/^[-*]\s*/, '').slice(0, 120)
      const row: DispatchProjectStatus = {
        project: r.project,
        headline,
        live: r.live,
        working: r.working,
        needsYou: r.needsYou,
      }
      if (r.idleMin !== undefined) row.idleMin = r.idleMin
      sotuEnrich(row, r.projectUri, now)
      return row
    })
}

const dispatchListThreads: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  ctx.requirePermission('spawn')
  const requestId = typeof data.requestId === 'string' ? data.requestId : undefined
  const userId = ctx.ws.data.userName ?? null
  // ON-OPEN MAINTENANCE (the 30-hour fix): condense aged-out turns into <memory> (the
  // read-triggered fold), then run the once-a-day Opus dream-cycle re-ground -- so
  // returning after a long gap shows a tight condensed memory, not the raw last
  // conversation. FIRE-AND-FORGET -- the open stays instant (never blocks on the LLM
  // work); when each step finishes, markDirty streams the fresh history to ALL the
  // user's devices (dispatch_history, Slice B). Both steps no-op (zero cost) when not due.
  void maintainOnOpen(userId, Date.now(), req => chat(req)).catch(() => null)
  const roster = listDispatchRosterCandidates(ctx.conversations)
  // STATUS strip (Phase 4b): the "where things stand" half on open, zero-LLM.
  const status = toStatusRows(projectOverviewRows({ store: ctx.conversations, callerConversationId: null }))
  const memory = readMemory(userId)
  const workspaces = workspaceSnapshot()
  // The living conversation itself (transcript + state blocks) so opening the
  // overlay loads the persistent dispatcher, not a blank feed (Slice C).
  const history = dumpUserHistory(userId)
  // Conventional `${request}_result` name (see DispatchThreadsResult): a thrown
  // dispatchListThreads (permission gate) is auto-replied by the router as
  // `dispatch_list_threads_result` ok:false, which must reach the same client
  // handler -- else the overlay wedges on "loading" forever.
  ctx.reply({ type: 'dispatch_list_threads_result', requestId, roster, status, memory, workspaces, history, userId })
}

type ControlAction = 'clear' | 'compact' | 'forget'

/** Perform a control verb and return the one-line confirmation. The store mutators
 *  re-sync every device live (the notifier inside markDirty). */
async function applyControlVerb(action: ControlAction, userId: string | null): Promise<string> {
  if (action === 'clear') {
    resetUserHistory(userId)
    return 'Cleared. Fresh dispatcher -- history, memory, and transcript wiped.'
  }
  if (action === 'forget') {
    forgetUserMemory(userId)
    return 'Forgot my long-term memory. The recent conversation is still here.'
  }
  const res = await compactNow(userId, Date.now(), req => chat(req))
  return res.ran ? `Compacted ${res.foldedTurns} turn(s) into memory.` : 'Nothing to compact -- already condensed.'
}

// ─── Memory + system-append file operations (/memory, /system) ─────

type FileAction = 'memory_read' | 'memory_write' | 'memory_refine' | 'system_read' | 'system_write'

const FILE_ACTIONS: Record<string, FileAction> = {
  memory_read: 'memory_read',
  memory_write: 'memory_write',
  memory_refine: 'memory_refine',
  system_read: 'system_read',
  system_write: 'system_write',
}

async function handleFileAction(action: FileAction, data: MessageData): Promise<Record<string, unknown>> {
  if (action === 'memory_read') {
    return { content: readMemoryRaw() }
  }
  if (action === 'memory_write') {
    const content = typeof data.content === 'string' ? data.content : ''
    writeMemory(content)
    return { ok: true }
  }
  if (action === 'memory_refine') {
    const instruction = typeof data.instruction === 'string' ? data.instruction.trim() : ''
    if (!instruction) return { ok: false, error: 'empty instruction' }
    const model = typeof data.model === 'string' && data.model ? data.model : undefined
    const result = await refineMemory(instruction, req => chat(req), model)
    return { ok: true, before: result.before, after: result.after, model: result.model }
  }
  if (action === 'system_read') {
    return { content: readSystemAppend() }
  }
  // system_write
  const content = typeof data.content === 'string' ? data.content : ''
  writeSystemAppend(content)
  return { ok: true }
}

/** Render a control verb's confirmation as a `converse` decision for the feed. */
function controlDecision(action: ControlAction, userId: string | null, reply: string): DispatchDecision {
  return {
    type: 'dispatch_decision',
    decisionId: `dec_${crypto.randomUUID()}`,
    intent: `/${action}`,
    disposition: 'converse',
    confidence: 1,
    reasoning: 'control verb',
    reply,
    executed: true,
    traceId: `trc_${crypto.randomUUID()}`,
    ts: Date.now(),
    userId,
  }
}

/**
 * A dispatcher CONTROL VERB (slash-command): clear / compact / forget. The reset
 * surface the user asked for. Acks the requesting overlay with a one-line confirmation
 * decision; the store mutators stream the new state to every device (markDirty).
 */
const dispatchControl: MessageHandler = async (ctx: HandlerContext, data: MessageData) => {
  ctx.requirePermission('spawn')
  const requestId = typeof data.requestId === 'string' ? data.requestId : undefined
  const userId = ctx.ws.data.userName ?? null
  const action = typeof data.action === 'string' ? data.action : ''

  // File operations (/memory, /system) return data, not decisions.
  const fileAction = FILE_ACTIONS[action]
  if (fileAction) {
    try {
      const result = await handleFileAction(fileAction, data)
      ctx.reply({ type: 'dispatch_control_result', requestId, action, ...result })
      ctx.log.debug(`dispatch_control [${userId ?? 'anon'}] ${action}`)
    } catch (e) {
      ctx.reply({ type: 'dispatch_control_result', requestId, action, ok: false, error: (e as Error).message })
    }
    return
  }

  if (action !== 'clear' && action !== 'compact' && action !== 'forget') {
    ctx.reply({ type: 'dispatch_request_result', requestId, ok: false, error: 'unknown dispatch_control action' })
    return
  }
  try {
    const reply = await applyControlVerb(action as ControlAction, userId)
    ctx.log.debug(`dispatch_control [${userId ?? 'anon'}] ${action}`)
    ctx.reply({
      type: 'dispatch_request_result',
      requestId,
      ok: true,
      decision: controlDecision(action as ControlAction, userId, reply),
    })
  } catch (e) {
    ctx.reply({ type: 'dispatch_request_result', requestId, ok: false, error: (e as Error).message })
    ctx.log.debug(`dispatch_control [${userId ?? 'anon'}] ${action} failed: ${(e as Error).message}`)
  }
}

export function registerDispatchHandlers(): void {
  // Control panel only -- share (guest) viewers must not drive the dispatcher.
  registerHandlers(
    {
      dispatch_request: dispatchRequest,
      dispatch_list_threads: dispatchListThreads,
      dispatch_control: dispatchControl,
    },
    CONTROL_PANEL_ONLY,
  )
}
