/**
 * Who owns a project-order row.
 *
 * The sidebar is per-user, so every read and write needs a user id. Two callers
 * have one already (cookie-authed HTTP requests, authed control-panel sockets).
 * The third -- a raw `RCLAUDE_SECRET` bearer call -- has no user identity at all,
 * and by Jonas's call it must NOT get a phantom row nobody ever sees: it shares
 * the admin's row, so a script and the browser agree on one sidebar.
 *
 * The admin is resolved from auth data, not hardcoded: `CLAUDWERK_ADMIN_ORDER_USER`
 * wins if set, otherwise the first non-revoked user holding an admin grant.
 */

import { getAllUsers } from './auth'
import { getAuthenticatedUser } from './auth-routes'
import { resolvePermissions } from './permissions'

/** Fallback owner when there is neither a session nor a resolvable admin. */
const ANON_ORDER_USER = '__anon__'

/** The user a bearer-secret (no session) call writes as. */
function adminOrderUser(): string {
  const configured = process.env.CLAUDWERK_ADMIN_ORDER_USER?.trim()
  if (configured) return configured
  const admin = getAllUsers().find(u => !u.revoked && resolvePermissions(u.grants ?? [], '*').isAdmin)
  return admin?.name ?? ANON_ORDER_USER
}

/** Owner for an HTTP request: the cookie session, else the admin (bearer secret). */
export function orderUserForRequest(req: Request): string {
  return getAuthenticatedUser(req) ?? adminOrderUser()
}

/** Owner for a control-panel socket: the authed name it carries, else the admin. */
export function orderUserForSocket(userName: string | undefined): string {
  return userName ?? adminOrderUser()
}
