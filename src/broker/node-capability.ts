/**
 * NODE CAPABILITIES -- the ONE place that answers "what may this credential do".
 *
 * This exists so the reporter credential is never enforced by an
 * `if (kind === 'reporter')` sprinkled through handlers. There is one table
 * below; every gate in the broker reads it:
 *
 *   - `resolveAuth` (auth-routes.ts) turns a secret into a role
 *   - `requireAuth` (auth-routes.ts) asks `canAuthenticateHttpRoutes` -- a
 *     reporter answers NO on every HTTP route, including /health
 *   - `routeMessage` (message-router.ts) asks `connectionMaySendMessage` -- a
 *     reporter may send exactly `report_node_stats` and nothing else
 *   - the spawn roster asks `canHostSpawns` -- a reporter answers NO, so it can
 *     never be picked as a spawn target
 *
 * The risk runs the other way round from a sentinel secret: a leaked `rpt_`
 * buys visibility into cpu percentages and nothing else, which is the entire
 * point -- reporters go on machines that must never hold spawn authority.
 */

import { REPORT_NODE_STATS } from '../shared/node-stats'

/** Every role a connection or credential can carry, across both the auth
 *  resolver and the WS router. One union so there is one capability table. */
export type CapabilityRole =
  | 'admin'
  | 'sentinel'
  | 'gateway'
  | 'reporter'
  | 'control-panel'
  | 'agent-host'
  | 'share'
  | 'none'

export type NodeCapability =
  /** May send the `report_node_stats` frame. */
  | 'report_node_stats'
  /** May authenticate an HTTP route (bearer secret). */
  | 'authenticate_http'
  /** May enter the sentinel roster used for spawn routing. */
  | 'host_spawns'

/**
 * THE table. A role's capabilities are exactly what is listed here -- there is
 * no implicit inheritance and no "everything except" fallback, so adding a role
 * without thinking about it grants nothing.
 *
 * `control-panel`, `agent-host` and `share` carry none of these node-level
 * capabilities; they are gated by the passkey/permission system instead and
 * appear here only so the table is total.
 */
const CAPABILITIES: Record<CapabilityRole, ReadonlySet<NodeCapability>> = {
  admin: new Set(['authenticate_http']),
  sentinel: new Set(['report_node_stats', 'authenticate_http', 'host_spawns']),
  gateway: new Set(['authenticate_http']),
  // THE reporter row. One capability. Deliberately tiny.
  reporter: new Set(['report_node_stats']),
  'control-panel': new Set(),
  'agent-host': new Set(),
  share: new Set(),
  none: new Set(),
}

export function roleHasCapability(role: CapabilityRole, capability: NodeCapability): boolean {
  return CAPABILITIES[role]?.has(capability) ?? false
}

/** `can_report_node_stats()` -- the reporter credential's one capability. */
export function canReportNodeStats(role: CapabilityRole): boolean {
  return roleHasCapability(role, 'report_node_stats')
}

/** WEBSOCKET ONLY: a reporter authenticates ZERO HTTP routes. Not a read
 *  route, not a health route. */
export function canAuthenticateHttpRoutes(role: CapabilityRole): boolean {
  return roleHasCapability(role, 'authenticate_http')
}

/** A role that cannot host spawns must never enter the spawn roster. */
export function canHostSpawns(role: CapabilityRole): boolean {
  return roleHasCapability(role, 'host_spawns')
}

/**
 * Roles whose WS traffic is restricted to an explicit message allowlist. A role
 * absent from this map is NOT capability-restricted at the router level and
 * falls through to the per-handler role gate as before.
 */
const RESTRICTED_MESSAGE_TYPES: Partial<Record<CapabilityRole, ReadonlySet<string>>> = {
  reporter: new Set([REPORT_NODE_STATS]),
}

/** The allowlist for a restricted role, or undefined when unrestricted. */
export function restrictedMessageTypes(role: CapabilityRole): ReadonlySet<string> | undefined {
  return RESTRICTED_MESSAGE_TYPES[role]
}

export type MessageVerdict = { ok: true } | { ok: false; reason: string }

/**
 * May a connection with this role send this message type? Every rejection
 * carries a reason string so the router can LOG EVERYTHING rather than
 * dropping the frame silently.
 */
export function connectionMaySendMessage(role: CapabilityRole, type: string): MessageVerdict {
  const allowed = restrictedMessageTypes(role)
  if (!allowed) return { ok: true }
  if (allowed.has(type)) {
    // Belt and braces: the allowlist and the capability table must agree. If
    // someone allowlists a type for a role that lacks the capability, deny.
    if (type === REPORT_NODE_STATS && !canReportNodeStats(role)) {
      return { ok: false, reason: `${role} lacks can_report_node_stats` }
    }
    return { ok: true }
  }
  return { ok: false, reason: `${role} may send only [${[...allowed].join(',')}], got ${type}` }
}
