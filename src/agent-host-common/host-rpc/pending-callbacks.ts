/**
 * Pending broker-RPC callbacks registry.
 *
 * The inter-conversation MCP tools (list/send/spawn/control/configure/rename/
 * revive/restart/get_spawn_diagnostics) send a request over the host transport
 * and await a matching `*_result` message the broker pushes back. This registry
 * holds the one-shot resolver for each in-flight request. The MCP-callbacks
 * builder REGISTERS resolvers here; the host's inbound WS dispatch INVOKES them.
 *
 * Lifted out of claude-agent-host so every agent host (claude, daemon, ...)
 * shares one implementation behind the same `HostTransport`. The registry is an
 * injected instance (not a module singleton) so two hosts in one process -- and
 * unit tests -- each get isolated state.
 */

import type { ConversationInfo } from '../mcp-host/mcp-tools/types'

/** Result of a `channel_send` (single target or fan-out). */
export interface SendResult {
  ok: boolean
  error?: string
  conversationId?: string
  targetConversationId?: string
  status?: 'delivered' | 'queued'
  canonicalAddress?: string
  results?: Array<{
    to: string
    ok: boolean
    status?: 'delivered' | 'queued'
    targetConversationId?: string
    error?: string
    canonicalAddress?: string
  }>
}

export type ListConversationsResolver = (
  sessions: ConversationInfo[],
  self?: Record<string, unknown>,
  issues?: Array<{
    severity: 'error' | 'warning'
    code: string
    conversation_id?: string
    project?: string
    message: string
  }>,
) => void

export type SpawnResult = { ok: boolean; error?: string; conversationId?: string; requestId?: string }
export type RestartResult = {
  ok: boolean
  error?: string
  name?: string
  selfRestart?: boolean
  alreadyEnded?: boolean
}
export type SpawnDiagnosticsResult = {
  ok: boolean
  jobId?: string
  error?: string
  diagnostics?: Record<string, unknown>
}

/**
 * The mutable set of in-flight resolvers. Single-shot scalar resolvers are
 * nulled after they fire; the Maps key concurrent requests by id.
 */
export interface PendingCallbacks {
  pendingListConversations: ListConversationsResolver | null
  pendingSendResult: ((result: SendResult) => void) | null
  pendingReviveResult: ((result: { ok: boolean; error?: string; name?: string }) => void) | null
  pendingRestartResult: ((result: RestartResult) => void) | null
  pendingSpawnResult: ((result: SpawnResult) => void) | null
  pendingSpawnRequestId: string | null
  pendingSpawnDiagnostics: Map<string, (result: SpawnDiagnosticsResult) => void>
  launchJobListeners: Map<string, (event: Record<string, unknown>) => void>
  pendingConfigureResult: ((result: { ok: boolean; error?: string }) => void) | null
  pendingRenameResult: ((result: { ok: boolean; error?: string }) => void) | null
  pendingControlResult: ((result: { ok: boolean; error?: string; name?: string }) => void) | null
  pendingRendezvous: Map<
    string,
    { resolve: (msg: Record<string, unknown>) => void; reject: (error: string) => void }
  >
}

/** Build a fresh registry. One per host (or per test). */
export function createPendingCallbacks(): PendingCallbacks {
  return {
    pendingListConversations: null,
    pendingSendResult: null,
    pendingReviveResult: null,
    pendingRestartResult: null,
    pendingSpawnResult: null,
    pendingSpawnRequestId: null,
    pendingSpawnDiagnostics: new Map(),
    launchJobListeners: new Map(),
    pendingConfigureResult: null,
    pendingRenameResult: null,
    pendingControlResult: null,
    pendingRendezvous: new Map(),
  }
}
