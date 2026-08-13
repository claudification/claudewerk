/**
 * Vacuum step broadcasts, scoped to admins.
 *
 * `broadcastToSubscribers` reaches EVERY connected panel, which is wrong here.
 * A vacuum step carries global infrastructure state -- which months exist, how
 * many rows and bytes they hold, who started a destructive run. That is
 * admin-only on the HTTP side, so broadcasting it unfiltered would hand a share
 * guest exactly what `createVacuumRouter` refuses to serve them.
 *
 * Two independent conditions, both required, matching `httpIsAdmin`:
 *   - the socket carries no share token (a share viewer is never an admin), and
 *   - its grants resolve to admin, or are absent entirely (a bearer-token
 *     connection, which is admin-level by definition).
 */

import type { ServerWebSocket } from 'bun'
import type { VacuumStepMessage } from '../../shared/protocol'
import { resolvePermissions, type UserGrant } from '../permissions'

interface SocketAuth {
  grants?: UserGrant[]
  shareToken?: string
}

export function isAdminSocket(ws: ServerWebSocket<unknown>): boolean {
  const data = ws.data as SocketAuth
  if (data?.shareToken) return false
  if (!data?.grants) return true // bearer-token connection
  return resolvePermissions(data.grants, '*').isAdmin
}

export function broadcastVacuumStep(subscribers: Set<ServerWebSocket<unknown>>, message: VacuumStepMessage): number {
  const json = JSON.stringify(message)
  let sent = 0
  for (const ws of subscribers) {
    if (!isAdminSocket(ws)) continue
    try {
      ws.send(json)
      sent++
    } catch {
      /* dead socket */
    }
  }
  return sent
}
