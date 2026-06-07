/**
 * Injected context for the shared MCP-channel callbacks.
 *
 * The lifted builder is host-agnostic: it speaks only to a minimal transport
 * (`send` + `isConnected`, satisfied by any `HostTransport`), the pending-RPC
 * registry, a diag sink, and a bundle of host-local sinks for the handful of
 * operations that genuinely differ per host (PTY keystrokes vs headless
 * stream-json injection, process exit, launch-event emission). The claude and
 * daemon hosts each supply their own sinks.
 */

import type { DialogLayout } from '../../shared/dialog-schema'
import type { HostTransport } from '../../shared/host-transport'
import type { PermissionRequestData } from '../mcp-host/mcp-tools/types'
import type { PendingCallbacks } from './pending-callbacks'

/** The slice of `HostTransport` the callbacks need: queue a message, ask if up. */
export type HostRpcTransport = Pick<HostTransport, 'send' | 'isConnected'>

export interface DiagSink {
  (type: string, msg: string, args?: unknown): void
}

/**
 * Host-local operations the lifted callbacks delegate back to the host. Each is
 * the part of an MCP callback that touches host-specific machinery (the PTY,
 * the headless stream proc, the interaction-replay registry, the launch-event
 * log, or process lifecycle) and therefore cannot live in shared code.
 */
export interface HostSinks {
  /** Push a `<channel>`-wrapped message to the agent (PTY/MCP vs headless stream). */
  deliverMessage: (content: string, meta: Record<string, string>) => void
  /** Auto-approve a permission request (headless stream vs MCP channel notification). */
  permissionAllow: (requestId: string) => void
  /** Register a permission request as an outstanding interaction (replayed on reconnect). */
  registerPermissionRequest: (data: PermissionRequestData) => void
  /** Show a dialog: register it as an outstanding interaction. */
  dialogShow: (dialogId: string, layout: DialogLayout) => void
  /** Dismiss a dialog: clear the outstanding interaction + notify the broker. */
  dialogDismiss: (dialogId: string, reason?: 'timeout' | 'cancelled') => void
  /** Toggle plan mode (headless control-request vs PTY `/plan`). */
  togglePlanMode: () => void
  /** Self-terminate the conversation (launch events + conversation-end + exit). */
  exit: (status: 'success' | 'error', message?: string) => void
}

export interface PermissionRules {
  shouldAutoApprove: (toolName: string, inputPreview: string) => boolean
}

export interface HostRpcContext {
  /** Stable conversation id (heartbeat / metadata routing). */
  conversationId: string
  /** Backend session id once learned (CC session id); null before promotion. */
  getCcSessionId: () => string | null
  cwd: string
  headless: boolean
  noBroker: boolean
  brokerUrl: string
  brokerSecret: string | undefined
  transport: HostRpcTransport
  diag: DiagSink
  pending: PendingCallbacks
  permissionRules: PermissionRules
  sinks: HostSinks
}

/** `ctx.getCcSessionId() ?? ctx.conversationId` -- the address the broker keys on. */
export function senderId(ctx: HostRpcContext): string {
  return ctx.getCcSessionId() || ctx.conversationId
}
