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
 *   - `requireAuth` then asks `canIngestNodeStatsHttp` for the ONE exception:
 *     `POST /api/node-stats`, whose whole body is a vitals frame
 *   - `routeMessage` (message-router.ts) asks `connectionMaySendMessage` -- a
 *     reporter may send exactly `node_stats` and nothing else
 *   - the spawn roster asks `canHostSpawns` -- a reporter answers NO, so it can
 *     never be picked as a spawn target
 *
 * The risk runs the other way round from a sentinel secret: a leaked `rpt_`
 * buys visibility into cpu percentages and nothing else, which is the entire
 * point -- reporters go on machines that must never hold spawn authority.
 */

/** The one message type a reporter may send. Imported from the CONTRACT, so the
 *  allowlist and the handler registration cannot name different strings. */
import { NODE_STATS_MESSAGE } from '../shared/node-stats'

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
  /** May send the `node_stats` frame. Named `report_node_stats` after the
   *  capability the card specifies (`can_report_node_stats()`), which is the
   *  ACTION; `node_stats` is the message that action produces. */
  | 'report_node_stats'
  /** May authenticate an HTTP route (bearer secret). */
  | 'authenticate_http'
  /**
   * May POST a vitals frame to `NODE_STATS_INGEST_PATH` -- and to nothing else.
   *
   * A SEPARATE ROW, deliberately: `authenticate_http` is "this credential opens
   * HTTP routes", and a reporter must keep answering NO to that. This is "this
   * credential opens ONE route whose entire body is a `node_stats` frame". A
   * grep for `authenticate_http` still finds every general HTTP door; the
   * one-route door is visible next to it rather than hidden inside it.
   *
   * Added by card `node-stats-http-ingest` (2026-08-19) so a reporter can be
   * fifteen lines of `sh` and a `curl` instead of 93 MB of compiled Bun.
   */
  | 'ingest_node_stats_http'
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
  // No `ingest_node_stats_http`: an admin secret has no node id, so there is no
  // row for it to write. It reaches the route through `authenticate_http` like
  // any other API caller and is turned away by the handler for want of an
  // identity -- which is the honest answer, not an accident.
  admin: new Set(['authenticate_http']),
  sentinel: new Set(['report_node_stats', 'authenticate_http', 'ingest_node_stats_http', 'host_spawns']),
  gateway: new Set(['authenticate_http']),
  // THE reporter row. Two capabilities now, both of them the SAME act (report
  // vitals) over the two transports it is allowed to use. Still no
  // `authenticate_http`: the general HTTP surface stays shut.
  reporter: new Set(['report_node_stats', 'ingest_node_stats_http']),
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

/** A reporter authenticates ZERO general HTTP routes. Not a read route, not a
 *  health route. Its one door is `canIngestNodeStatsHttp` below, which opens
 *  exactly one path and reads exactly one message. */
export function canAuthenticateHttpRoutes(role: CapabilityRole): boolean {
  return roleHasCapability(role, 'authenticate_http')
}

/** THE ONE HTTP DOOR a websocket-only node credential opens: `POST
 *  NODE_STATS_INGEST_PATH`, body = a `node_stats` frame, nothing else. */
export function canIngestNodeStatsHttp(role: CapabilityRole): boolean {
  return roleHasCapability(role, 'ingest_node_stats_http')
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
  reporter: new Set([NODE_STATS_MESSAGE]),
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
    if (type === NODE_STATS_MESSAGE && !canReportNodeStats(role)) {
      return { ok: false, reason: `${role} lacks can_report_node_stats` }
    }
    return { ok: true }
  }
  return { ok: false, reason: `${role} may send only [${[...allowed].join(',')}], got ${type}` }
}
