/**
 * Message router: dispatches WS messages to handler functions.
 * Handlers register by message type. Guards throw GuardError
 * which the router catches and sends as error replies.
 *
 * Each message type may also declare a role allowlist; the router rejects
 * messages from connections whose role is not in the set. (Audit C3)
 */

import { GuardError, type HandlerContext, type MessageData, type MessageHandler, type WsData } from './handler-context'

/**
 * Connection role. Determined from WsData fields set at WS upgrade
 * (or by a self-declared role-marker handler like sentinel_identify
 * for the legacy sentinel auth path).
 */
export type WsRole = 'agent-host' | 'control-panel' | 'sentinel' | 'gateway' | 'share'

/** Common role groups for `registerHandlers` second arg. */
export const AGENT_HOST_ONLY: WsRole[] = ['agent-host']
export const SENTINEL_ONLY: WsRole[] = ['sentinel']
export const GATEWAY_ONLY: WsRole[] = ['gateway']
/** Control panel + share viewers (dashboards). */
export const DASHBOARD_ROLES: WsRole[] = ['control-panel', 'share']
/** Everyone (the implicit default before C3). */
export const ANY_ROLE: WsRole[] = ['agent-host', 'control-panel', 'sentinel', 'gateway', 'share']

/**
 * Derive the connection's role from its WsData. Order of precedence:
 *   share > gateway > sentinel > control-panel > agent-host
 *
 * The `agent-host` role is the default for bearer-secret authentication
 * with no other role marker (the legacy "rclaude secret" path).
 */
export function detectRole(data: WsData): WsRole {
  if (data.isShare) return 'share'
  if (data.isGateway) return 'gateway'
  // The dedicated shell-data socket is a sentinel-originated byte pipe; route its
  // shell_data/shell_replay frames under the sentinel role.
  if (data.isSentinel || data.sentinelId || data.isShellData) return 'sentinel'
  if (data.userName || data.isControlPanel) return 'control-panel'
  return 'agent-host'
}

interface HandlerEntry {
  handler: MessageHandler
  /** Allowed roles. `undefined` = any role allowed (legacy default). */
  roles?: WsRole[]
}

const handlers = new Map<string, HandlerEntry>()

/**
 * Echo the caller's `requestId` back on a reply when present. RPC-style callers
 * (brokerRpc / MCP tools) match the response to their pending promise by
 * requestId; a rejection reply WITHOUT it can never be matched, so the call
 * hangs to a silent timeout instead of surfacing the error. Every rejection the
 * router emits must carry this. (Pillar B: fixed the 30s MCP timeout on
 * role-rejected recap_create.)
 */
function requestIdEcho(data: MessageData): { requestId?: string } {
  return typeof data.requestId === 'string' ? { requestId: data.requestId } : {}
}

/**
 * Register multiple handlers at once. If `roles` is provided, the router
 * will reject messages of these types from connections whose role is not
 * in the set. Omit `roles` to keep the legacy any-role behavior.
 */
export function registerHandlers(map: Record<string, MessageHandler>, roles?: WsRole[]): void {
  for (const [type, handler] of Object.entries(map)) {
    handlers.set(type, { handler, roles })
  }
}

/** Route a message to its handler. Returns true if handled. */
export function routeMessage(ctx: HandlerContext, type: string, data: MessageData): boolean {
  const entry = handlers.get(type)
  if (!entry) return false

  // Role gate (Audit C3). When a handler declares allowed roles, reject
  // messages from connections whose role isn't in the set. The reply uses
  // the `_result` suffix so the dashboard surfaces the error consistently
  // with GuardError.
  if (entry.roles) {
    const role = detectRole(ctx.ws.data)
    if (!entry.roles.includes(role)) {
      ctx.reply({
        type: `${type}_result`,
        ok: false,
        error: `Forbidden: ${type} not allowed for ${role}`,
        ...requestIdEcho(data),
      })
      ctx.log.debug(`[router] rejected ${type} from role=${role} (allowed=[${entry.roles.join(',')}])`)
      return true
    }
  }

  // Per-conversation share scope (defense in depth). A share viewer bound to
  // conversation A must never act on conversation B even when the per-handler
  // permission check passes (e.g. default share grants chat:read on the whole
  // project URI). Reject any message whose `conversationId` field disagrees
  // with the share's bound conversation. Handler-level project gating still
  // applies on top of this.
  const shareConvId = ctx.ws.data.shareConversationId
  if (shareConvId) {
    const target = (data as Record<string, unknown>).conversationId
    if (typeof target === 'string' && target !== shareConvId) {
      ctx.reply({
        type: `${type}_result`,
        ok: false,
        error: 'Forbidden: share is scoped to a different conversation',
        ...requestIdEcho(data),
      })
      ctx.log.debug(
        `[router] share-scope reject ${type}: target=${target.slice(0, 8)} bound=${shareConvId.slice(0, 8)}`,
      )
      return true
    }
  }

  try {
    const result = entry.handler(ctx, data)
    if (result instanceof Promise) {
      result.catch(err => {
        console.error(`[router] Async handler error for ${type}:`, err)
        ctx.reply({
          type: `${type}_result`,
          ok: false,
          error: err instanceof Error ? err.message : 'Internal error',
          ...requestIdEcho(data),
        })
      })
    }
  } catch (err) {
    if (err instanceof GuardError) {
      ctx.reply({ type: `${type}_result`, ok: false, error: err.message, ...requestIdEcho(data) })
    } else {
      console.error(`[router] Handler error for ${type}:`, err)
      ctx.reply({ type: `${type}_result`, ok: false, error: 'Internal error', ...requestIdEcho(data) })
    }
  }

  return true
}
