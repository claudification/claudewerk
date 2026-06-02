/**
 * Universal control-debug forwarder (broker side).
 *
 * WEB sends `debug_control_send` -> broker permission-gates + audits + checks
 * the target conversation's transport, forwards to the owning agent host, and
 * relays the agent host's `debug_trace_event` / `debug_control_result` back to
 * the control-panel viewers. The broker NEVER interprets command/payload -- it
 * only routes (and never touches ccSessionId; boundary-clean).
 *
 * Transport gate (prevents a hung modal):
 *   - cc_control  requires a NON-daemon (headless) conversation. On a daemon
 *     conversation the worker's control channel is internal -> unsupported.
 *   - daemon_op   requires a daemon conversation -> forwarded to the
 *     daemon-agent-host. On non-daemon -> unsupported.
 * The agent host makes the final call (e.g. PTY has no stream process), so a
 * forwarded command may still come back `unsupported_transport`.
 */

import { getControlCommandSpec } from '../../shared/cc-control-commands'
import type { HandlerContext, MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, registerHandlers } from '../message-router'
import { resolvePermissions } from '../permissions'
import { resolveConversationSocket } from './socket-routing'

/** True if the control-panel caller is an admin for this project (bearer/legacy
 *  = admin, matching requirePermission's own fallback). Gates danger commands. */
function isAdminCaller(ctx: HandlerContext, project: string): boolean {
  if (!ctx.ws.data.isControlPanel) return true
  const grants = ctx.ws.data.grants
  if (!grants) return true
  return resolvePermissions(grants, project).isAdmin
}

function emitTrace(
  ctx: HandlerContext,
  conversationId: string,
  traceId: string,
  seam: string,
  extra: Record<string, unknown> = {},
): void {
  ctx.conversations.broadcastToChannel('conversation:transcript', conversationId, {
    type: 'debug_trace_event',
    traceId,
    conversationId,
    seam,
    t: Date.now(),
    ...extra,
  })
}

function emitResult(
  ctx: HandlerContext,
  conversationId: string,
  traceId: string,
  channel: string,
  command: string,
  r: { ok: boolean; error?: string; code?: string },
): void {
  ctx.conversations.broadcastToChannel('conversation:transcript', conversationId, {
    type: 'debug_control_result',
    traceId,
    conversationId,
    channel,
    command,
    ok: r.ok,
    error: r.error,
    code: r.code,
    elapsedMs: 0,
    t: Date.now(),
  })
}

const debugControlSend: MessageHandler = (ctx, data) => {
  const traceId = typeof data.traceId === 'string' ? data.traceId : ''
  const conversationId = typeof data.targetConversation === 'string' ? data.targetConversation : ''
  const channel = typeof data.channel === 'string' ? data.channel : ''
  const command = typeof data.command === 'string' ? data.command : ''
  const payload = data.payload && typeof data.payload === 'object' ? (data.payload as Record<string, unknown>) : {}

  if (!conversationId || !channel || !command) {
    if (conversationId)
      emitResult(ctx, conversationId, traceId, channel, command, { ok: false, code: 'bad_request', error: 'missing fields' })
    return
  }

  const conv = ctx.conversations.getConversation(conversationId)
  if (!conv) {
    emitResult(ctx, conversationId, traceId, channel, command, { ok: false, code: 'conversation_not_found', error: 'conversation not found' })
    return
  }

  // Baseline gate: control-tool grade (settings). Admins bypass. The whole
  // modal is a loaded gun, so danger-flagged commands (read_file / mcp_call /
  // kill / shutdown) additionally require admin. Every send is audited.
  ctx.requirePermission('settings', conv.project)
  const spec = getControlCommandSpec(channel as 'cc_control' | 'daemon_op', command)
  if (spec?.danger && !isAdminCaller(ctx, conv.project)) {
    emitResult(ctx, conversationId, traceId, channel, command, { ok: false, code: 'forbidden', error: `danger command ${command} requires admin` })
    return
  }

  const who = ctx.ws.data.isControlPanel ? 'control-panel' : (ctx.ws.data.conversationId?.slice(0, 8) ?? 'unknown')
  ctx.log.info(`[debug-control] ${who} -> ${conversationId.slice(0, 8)} ${channel}:${command}${spec?.danger ? ' [DANGER]' : ''}`)

  emitTrace(ctx, conversationId, traceId, 'broker_recv', { detail: `${channel}:${command}` })

  const isDaemon = conv.agentHostType === 'daemon'
  if (channel === 'cc_control' && isDaemon) {
    emitTrace(ctx, conversationId, traceId, 'error', { detail: 'unsupported_transport' })
    emitResult(ctx, conversationId, traceId, channel, command, { ok: false, code: 'unsupported_transport', error: 'cc_control is not reachable on a daemon conversation (worker control channel is internal)' })
    return
  }
  if (channel === 'daemon_op' && !isDaemon) {
    emitTrace(ctx, conversationId, traceId, 'error', { detail: 'unsupported_transport' })
    emitResult(ctx, conversationId, traceId, channel, command, { ok: false, code: 'unsupported_transport', error: 'daemon_op is only available on a daemon conversation' })
    return
  }

  const ws = resolveConversationSocket(ctx, conversationId)
  if (!ws) {
    emitTrace(ctx, conversationId, traceId, 'error', { detail: 'no_agent_host' })
    emitResult(ctx, conversationId, traceId, channel, command, { ok: false, code: 'no_agent_host', error: 'conversation has no live agent host' })
    return
  }

  ws.send(JSON.stringify({ type: 'debug_control_send', traceId, targetConversation: conversationId, channel, command, payload }))
  emitTrace(ctx, conversationId, traceId, 'broker_forward')
}

// Relay the agent host's trace/result back to the control-panel viewers.
const debugRelay: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId as string) || ctx.ws.data.conversationId
  if (!conversationId) return
  ctx.conversations.broadcastToChannel('conversation:transcript', conversationId, { ...data })
}

export function registerDebugControlHandlers(): void {
  registerHandlers({ debug_control_send: debugControlSend }, ['control-panel'])
  registerHandlers({ debug_trace_event: debugRelay, debug_control_result: debugRelay }, AGENT_HOST_ONLY)
}
