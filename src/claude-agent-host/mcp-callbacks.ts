/**
 * MCP Channel Callbacks (claude-agent-host adapter).
 *
 * The callback LOGIC is shared -- it lives in `agent-host-common/host-rpc`,
 * parameterized over a transport + host-local sinks. This file is the thin
 * claude-specific adapter: it wires the shared builder to this host's wsClient,
 * PTY/headless stream proc, interaction registry, and launch-event machinery.
 */

import {
  buildMcpChannelCallbacks,
  type HostRpcContext,
  type HostSinks,
  type PendingCallbacks,
} from '../agent-host-common/host-rpc'
import { pushChannelMessage, sendPermissionResponse } from '../agent-host-common/mcp-host/mcp-channel'
import type { McpChannelCallbacks } from '../agent-host-common/mcp-host/mcp-channel'
import type { AgentHostMessage } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'
import { debug } from './debug'
import { beginLaunch, emitLaunchEvent } from './launch-events'
import { clearInteraction, sendInteraction } from './pending-interactions'

export interface McpCallbackDeps {
  brokerUrl: string
  brokerSecret: string | undefined
  noBroker: boolean
  conversationId: string
  cwd: string
  headless: boolean
  channelEnabled: boolean
  cleanup: () => void
  /** Shared inter-conversation RPC registry (same instance broker-connection dispatches into). */
  pending: PendingCallbacks
}

/** The host-local operations the shared callbacks delegate back to this host. */
function buildSinks(ctx: AgentHostContext, deps: McpCallbackDeps): HostSinks {
  return {
    deliverMessage(content, meta) {
      if (deps.headless && ctx.streamProc) {
        const attrs = Object.entries(meta)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ')
        ctx.streamProc.sendUserMessage(`<channel ${attrs}>\n${content}\n</channel>`)
        ctx.diag('headless', `Delivered message: ${meta.sender} ${content.slice(0, 60)}`)
      } else {
        pushChannelMessage(content, meta)
        ctx.diag('channel', `Delivered message: ${meta.sender} ${content.slice(0, 60)}`)
      }
    },

    permissionAllow(requestId) {
      if (deps.headless && ctx.streamProc) {
        ctx.streamProc.sendPermissionResponse(requestId, true)
      } else {
        sendPermissionResponse(requestId, 'allow').catch((err: unknown) => {
          debug(`sendPermissionResponse (auto) error: ${err instanceof Error ? err.message : err}`)
        })
      }
    },

    registerPermissionRequest(data) {
      sendInteraction(ctx, 'permission_request', data.requestId, {
        type: 'permission_request',
        conversationId: ctx.claudeSessionId || deps.conversationId,
        requestId: data.requestId,
        toolName: data.toolName,
        description: data.description,
        inputPreview: data.inputPreview,
      })
    },

    dialogShow(dialogId, layout) {
      sendInteraction(ctx, 'dialog_show', dialogId, {
        type: 'dialog_show',
        conversationId: ctx.conversationId,
        dialogId,
        layout,
      } as unknown as AgentHostMessage)
    },

    dialogDismiss(dialogId, reason) {
      clearInteraction(ctx, dialogId)
      ctx.wsClient?.send({
        type: 'dialog_dismiss',
        conversationId: ctx.conversationId,
        dialogId,
        ...(reason ? { reason } : {}),
      } as unknown as AgentHostMessage)
    },

    togglePlanMode() {
      if (deps.headless) {
        if (ctx.streamProc) {
          ctx.diag('channel', 'toggle_plan_mode: sending set_permission_mode via control_request')
          ctx.streamProc.sendSetPermissionMode('plan')
        }
      } else {
        ctx.diag('channel', 'toggle_plan_mode: injecting /plan via PTY')
        if (ctx.ptyProcess) ctx.ptyProcess.write('/plan\r')
      }
    },

    exit(status, message) {
      const detail = message ? `${status}: ${message}` : status
      beginLaunch(ctx, 'live')
      emitLaunchEvent(ctx, 'conversation_exit', { detail, raw: { status, message } })
      const endReason = status === 'error' ? `self_exit_error: ${message || 'unknown'}` : 'self_exit'
      if (ctx.claudeSessionId) {
        ctx.wsClient?.sendConversationEnd(endReason, {
          source: 'mcp-exit-session',
          detail: {
            ccSessionId: ctx.claudeSessionId,
            agentHostPid: process.pid,
            note: `Agent self-terminated via mcp__rclaude__exit_session (status=${status})${message ? `: ${message}` : ''}`,
          },
        })
      }
      setTimeout(() => {
        deps.cleanup()
        process.exit(status === 'error' ? 1 : 0)
      }, 500)
    },
  }
}

export function buildMcpCallbacksWithRules(
  ctx: AgentHostContext,
  deps: McpCallbackDeps,
  permissionRules: { shouldAutoApprove: (toolName: string, inputPreview: string) => boolean },
): McpChannelCallbacks {
  const rpcCtx: HostRpcContext = {
    conversationId: deps.conversationId,
    getCcSessionId: () => ctx.claudeSessionId,
    cwd: deps.cwd,
    headless: deps.headless,
    noBroker: deps.noBroker,
    brokerUrl: deps.brokerUrl,
    brokerSecret: deps.brokerSecret,
    transport: {
      send: msg => ctx.wsClient?.send(msg),
      isConnected: () => ctx.wsClient?.isConnected() ?? false,
    },
    diag: ctx.diag,
    pending: deps.pending,
    permissionRules,
    sinks: buildSinks(ctx, deps),
  }
  return buildMcpChannelCallbacks(rpcCtx)
}
