/**
 * MCP channel callbacks (daemon-agent-host adapter).
 *
 * The callback LOGIC is shared -- it lives in `agent-host-common/host-rpc`,
 * parameterized over a transport + host-local sinks (Phase 1 of the MCP toolset
 * unification). This file is the thin daemon-specific adapter: it wires the
 * shared builder to this host's broker transport, the MCP channel (the daemon
 * worker is interactive `claude` on the channel, so inter-conversation +
 * dialog messages reach it exactly like a PTY claude host), the worker's attach
 * PTY (plan-mode toggle) and the host's own shutdown path (self-exit).
 *
 * Unlike the claude host, a daemon worker has no headless stream proc and no
 * per-conversation permission-rule registry: gates surface conversationally
 * (see daemon-control.ts), so the auto-approve rule is a constant `false`.
 */

import {
  buildMcpChannelCallbacks,
  createPendingCallbacks,
  type HostRpcContext,
  type HostRpcTransport,
  type HostSinks,
  type PendingCallbacks,
} from '../agent-host-common/host-rpc'
import type { McpChannelCallbacks } from '../agent-host-common/mcp-host/mcp-channel'
import { pushChannelMessage, sendPermissionResponse } from '../agent-host-common/mcp-host/mcp-channel'
import type { AttachHandle } from '../shared/cc-daemon/attach'
import type { AgentHostMessage } from '../shared/protocol'

export interface DaemonMcpCallbackDeps {
  conversationId: string
  cwd: string
  brokerUrl: string
  brokerSecret: string | undefined
  /** Broker transport (send queues even while reconnecting). */
  transport: HostRpcTransport
  /** Live worker CC session id (null until the observer derives the first one). */
  getCcSessionId: () => string | null
  diag: (type: string, msg: string, args?: unknown) => void
  log: (msg: string) => void
  /** Live attach handle -- plan-mode toggle types `/plan` into the worker PTY. */
  getAttachHandle: () => AttachHandle | null
  /** Self-terminate the conversation (mcp__rclaude__exit_conversation). */
  requestExit: (status: 'success' | 'error', message?: string) => void
}

/** The host-local operations the shared callbacks delegate back to this host. */
function buildSinks(deps: DaemonMcpCallbackDeps): HostSinks {
  return {
    deliverMessage(content, meta) {
      // The daemon worker is interactive `claude` connected to this host's MCP
      // channel server -- a `<channel>` notification reaches it exactly like the
      // PTY claude host (no headless stream proc to inject into).
      pushChannelMessage(content, meta).catch((err: unknown) =>
        deps.log(`deliverMessage push failed: ${err instanceof Error ? err.message : err}`),
      )
    },

    permissionAllow(requestId) {
      sendPermissionResponse(requestId, 'allow').catch((err: unknown) =>
        deps.log(`permissionAllow failed: ${err instanceof Error ? err.message : err}`),
      )
    },

    registerPermissionRequest(data) {
      deps.transport.send({
        type: 'permission_request',
        conversationId: deps.getCcSessionId() || deps.conversationId,
        requestId: data.requestId,
        toolName: data.toolName,
        description: data.description,
        inputPreview: data.inputPreview,
      } as unknown as AgentHostMessage)
    },

    dialogShow(dialogId, layout) {
      deps.transport.send({
        type: 'dialog_show',
        conversationId: deps.conversationId,
        dialogId,
        layout,
      } as unknown as AgentHostMessage)
    },

    dialogDismiss(dialogId, reason) {
      deps.transport.send({
        type: 'dialog_dismiss',
        conversationId: deps.conversationId,
        dialogId,
        ...(reason ? { reason } : {}),
      } as unknown as AgentHostMessage)
    },

    togglePlanMode() {
      const handle = deps.getAttachHandle()
      if (handle && !handle.closed) {
        deps.diag('channel', 'toggle_plan_mode: typing /plan into the worker PTY')
        handle.writeInput('/plan\r')
      } else {
        deps.diag('channel', 'toggle_plan_mode: no live attach handle')
      }
    },

    exit(status, message) {
      deps.requestExit(status, message)
    },
  }
}

/**
 * Build the full `McpChannelCallbacks` for a daemon-backed conversation, plus
 * the pending-RPC registry the host's inbound dispatch must resolve into (the
 * caller threads it through `dispatchHostRpcResult`).
 */
export function buildDaemonMcpCallbacks(deps: DaemonMcpCallbackDeps): {
  callbacks: McpChannelCallbacks
  pending: PendingCallbacks
} {
  const pending = createPendingCallbacks()
  const rpcCtx: HostRpcContext = {
    conversationId: deps.conversationId,
    getCcSessionId: deps.getCcSessionId,
    cwd: deps.cwd,
    headless: false,
    noBroker: false,
    brokerUrl: deps.brokerUrl,
    brokerSecret: deps.brokerSecret,
    transport: deps.transport,
    diag: deps.diag,
    pending,
    permissionRules: { shouldAutoApprove: () => false },
    sinks: buildSinks(deps),
  }
  return { callbacks: buildMcpChannelCallbacks(rpcCtx), pending }
}
