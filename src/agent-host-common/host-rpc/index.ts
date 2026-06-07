/**
 * Shared host MCP-channel callbacks.
 *
 * `buildMcpChannelCallbacks` assembles the full `McpChannelCallbacks` object
 * that `initMcpChannel` consumes, from a host-agnostic `HostRpcContext`. The
 * broker-RPC half (inter-conversation tools) and the host-local half (notify,
 * share-file, permission/dialog/exit) are built separately and merged. Every
 * agent host -- claude today, daemon next -- constructs this same object,
 * differing only in the `sinks` and transport it injects.
 */

import type { McpChannelCallbacks } from '../mcp-host/mcp-tools/types'
import type { HostRpcContext } from './context'
import { buildHostLocalCallbacks } from './host-local-callbacks'
import { buildInterConversationCallbacks } from './inter-conversation-callbacks'

export type {
  HostRpcContext,
  HostRpcTransport,
  HostSinks,
  PermissionRules,
  DiagSink,
} from './context'
export { senderId } from './context'
export { type PendingCallbacks, createPendingCallbacks } from './pending-callbacks'

export function buildMcpChannelCallbacks(ctx: HostRpcContext): McpChannelCallbacks {
  return {
    ...buildInterConversationCallbacks(ctx),
    ...buildHostLocalCallbacks(ctx),
  }
}
