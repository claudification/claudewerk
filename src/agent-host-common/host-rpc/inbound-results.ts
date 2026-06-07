/**
 * Inbound MCP message router.
 *
 * The inter-conversation MCP tools (list/send/spawn/control/configure/rename/
 * revive/restart/get_spawn_diagnostics) send a request over the host transport
 * and await a matching `*_result` the broker pushes back (see
 * pending-callbacks.ts); the `dialog` tool likewise awaits a `dialog_result`.
 * This routes one inbound broker message to the right pending resolver -- the
 * inbound half of the lift the callbacks builder did for the outbound half.
 *
 * The daemon host -- which dispatches raw `BrokerMessage`s -- calls this
 * directly. The claude host still wires these same results through its bespoke
 * ws-client callback layer (`claude-agent-host/broker-connection.ts`); adopting
 * this dispatcher there too (once ws-client forwards the raw message) is the
 * follow-up that makes this the single copy -- deferred from Phase 3c to keep the
 * default host's message layer out of the blast radius. Both already resolve the
 * one shared `PendingCallbacks` registry. Returns true when the message was
 * consumed, false to let the host fall through to its own handling (terminal
 * data, control verbs, ...).
 */

import type { DialogResult } from '../../shared/dialog-schema'
import { keepaliveDialog, resolveDialog } from '../mcp-host/mcp-channel'
import { dispatchBrokerRpcResponse } from '../mcp-host/mcp-tools/lib/broker-rpc'
import type { ConversationInfo } from '../mcp-host/mcp-tools/types'
import type { DiagSink } from './context'
import type { ListConversationsResolver, PendingCallbacks, RestartResult } from './pending-callbacks'

type Msg = Record<string, unknown>
type ResultHandler = (msg: Msg, pending: PendingCallbacks, diag: DiagSink) => void

/** Re-read a loose inbound message as the typed result a resolver expects. */
function as<T>(msg: Msg): T {
  return msg as unknown as T
}

/** Drop a `channel_spawn_result` whose requestId doesn't match the in-flight spawn. */
function handleSpawnResult(msg: Msg, pending: PendingCallbacks, diag: DiagSink): void {
  const expected = pending.pendingSpawnRequestId
  const got = typeof msg.requestId === 'string' ? msg.requestId : undefined
  if (got && expected && got !== expected) {
    diag('channel', `Ignoring stale channel_spawn_result (expected=${expected.slice(0, 8)}, got=${got.slice(0, 8)})`)
    return
  }
  pending.pendingSpawnResult?.(as(msg))
}

/** Route a spawn-diagnostics reply to its per-job resolver, clearing the entry. */
function handleSpawnDiagnostics(msg: Msg, pending: PendingCallbacks): void {
  const jobId = typeof msg.jobId === 'string' ? msg.jobId : undefined
  if (!jobId) return
  const resolver = pending.pendingSpawnDiagnostics.get(jobId)
  if (!resolver) return
  pending.pendingSpawnDiagnostics.delete(jobId)
  resolver(as(msg))
}

/** Fan a launch job event (progress/log/complete/failed) to its per-job listener. */
function handleLaunchEvent(msg: Msg, pending: PendingCallbacks): void {
  const jobId = typeof msg.jobId === 'string' ? msg.jobId : undefined
  if (jobId) pending.launchJobListeners.get(jobId)?.(msg)
}

/** Resolve/reject a spawn/revive/restart rendezvous keyed on the spawned id. */
function handleRendezvous(msg: Msg, pending: PendingCallbacks, diag: DiagSink): void {
  const msgType = msg.type as string
  const isReady = msgType.endsWith('_ready')
  const action = msgType.split('_')[0] // 'spawn' | 'revive' | 'restart'
  const error = typeof msg.error === 'string' ? msg.error : undefined
  diag('rendezvous', isReady ? `${action} ready` : `${action} timeout: ${error || 'unknown'}`)

  const key = msg.conversationId as string
  const rendezvous = pending.pendingRendezvous.get(key)
  if (!rendezvous) return
  pending.pendingRendezvous.delete(key)
  if (isReady) rendezvous.resolve(msg)
  else rendezvous.reject(error || `${action} timed out`)
}

/** type -> handler. The main dispatcher is a single O(1) lookup over this. */
const HANDLERS: Record<string, ResultHandler> = {
  channel_conversations_list: (msg, p) =>
    p.pendingListConversations?.(
      (msg.conversations as ConversationInfo[]) ?? [],
      msg.self as Record<string, unknown> | undefined,
      msg.issues as Parameters<ListConversationsResolver>[2],
    ),
  channel_send_result: (msg, p) => p.pendingSendResult?.(as(msg)),
  channel_revive_result: (msg, p) => p.pendingReviveResult?.(as(msg)),
  channel_restart_result: (msg, p) => p.pendingRestartResult?.(as<RestartResult>(msg)),
  channel_spawn_result: handleSpawnResult,
  spawn_diagnostics_result: handleSpawnDiagnostics,
  channel_configure_result: (msg, p) => p.pendingConfigureResult?.(as(msg)),
  rename_conversation_result: (msg, p) => p.pendingRenameResult?.(as(msg)),
  conversation_control_result: (msg, p) => p.pendingControlResult?.(as(msg)),
  launch_progress: handleLaunchEvent,
  launch_log: handleLaunchEvent,
  job_complete: handleLaunchEvent,
  job_failed: handleLaunchEvent,
  spawn_ready: handleRendezvous,
  spawn_timeout: handleRendezvous,
  revive_ready: handleRendezvous,
  revive_timeout: handleRendezvous,
  restart_ready: handleRendezvous,
  restart_timeout: handleRendezvous,
  // dialog answers (the daemon has no pending-interaction replay registry, so
  // unlike the claude host there is no clearInteraction to pair with these).
  dialog_result: msg => resolveDialog(msg.dialogId as string, msg.result as DialogResult),
  dialog_keepalive: msg => keepaliveDialog(msg.dialogId as string),
}

/** Route one inbound broker message into the pending-RPC registry / dialog state. */
export function dispatchHostRpcResult(msg: Msg, pending: PendingCallbacks, diag: DiagSink): boolean {
  const type = typeof msg.type === 'string' ? msg.type : ''
  const handler = HANDLERS[type]
  if (handler) {
    handler(msg, pending, diag)
    return true
  }
  // recap_* broker-RPC replies -- only when they carry a requestId we minted
  // (dispatchBrokerRpcResponse no-ops on an unmatched id, so this is safe).
  if (type.startsWith('recap_') && typeof msg.requestId === 'string') return dispatchBrokerRpcResponse(msg)
  return false
}
