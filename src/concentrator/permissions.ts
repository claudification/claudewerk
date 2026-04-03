/**
 * Permission system: grant-based, CWD-scoped, with roles + permissions.
 *
 * Roles are shorthand for permission bundles (admin -> all permissions).
 * Permissions are granular capabilities (chat, terminal:read, etc.).
 * Grants combine both: roles expand first, then explicit permissions merge in.
 */

// ─── Roles (expand into permission sets) ──────────────────────────

export type Role = 'admin'

/** Role -> permission expansion map */
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ['chat', 'chat:read', 'terminal', 'terminal:read', 'files', 'files:read', 'spawn', 'settings', 'voice'],
}

// ─── Permissions (granular capabilities) ──────────────────────────

export type Permission =
  | 'chat'
  | 'chat:read'
  | 'terminal'
  | 'terminal:read'
  | 'files'
  | 'files:read'
  | 'spawn'
  | 'settings'
  | 'voice'

// ─── Grants ───────────────────────────────────────────────────────

export interface UserGrant {
  /** CWD glob pattern. '*' = all projects. */
  cwd: string
  /** Roles that expand into permission sets */
  roles?: Role[]
  /** Granular permissions (combined with role-expanded permissions) */
  permissions?: Permission[]
  /** Grant is not valid before this timestamp (ms). Omit = immediately valid. */
  notBefore?: number
  /** Grant expires after this timestamp (ms). Omit = never expires. */
  notAfter?: number
}

// ─── Internal helpers ─────────────────────────────────────────────

function matchCwdGlob(pattern: string, cwd: string): boolean {
  if (pattern === '*') return true
  if (pattern === cwd) return true
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1)
    return cwd.startsWith(prefix) || cwd === pattern.slice(0, -2)
  }
  return false
}

function isGrantActive(grant: UserGrant, now = Date.now()): boolean {
  if (grant.notBefore && now < grant.notBefore) return false
  if (grant.notAfter && now > grant.notAfter) return false
  return true
}

function hasRole(grant: UserGrant, role: Role): boolean {
  return grant.roles?.includes(role) ?? false
}

// ─── Resolution ───────────────────────────────────────────────────

/**
 * Resolve effective permissions for grants against a specific CWD.
 * Expands roles into permissions, merges explicit permissions, applies hierarchy.
 */
export function resolvePermissions(
  grants: UserGrant[],
  cwd: string,
): { permissions: Set<Permission>; isAdmin: boolean } {
  const result = new Set<Permission>()
  let admin = false
  const now = Date.now()

  for (const grant of grants) {
    if (!isGrantActive(grant, now)) continue
    if (!matchCwdGlob(grant.cwd, cwd)) continue

    // Expand roles into permissions
    if (grant.roles) {
      for (const role of grant.roles) {
        if (role === 'admin') admin = true
        const expanded = ROLE_PERMISSIONS[role]
        if (expanded) for (const p of expanded) result.add(p)
      }
    }

    // Add explicit permissions
    if (grant.permissions) {
      for (const p of grant.permissions) result.add(p)
    }
  }

  // Hierarchical implications
  if (result.has('chat')) result.add('chat:read')
  if (result.has('terminal')) result.add('terminal:read')
  if (result.has('files')) result.add('files:read')

  return { permissions: result, isAdmin: admin }
}

// ─── Resolved flags (what the client receives) ───────────────────

export interface ResolvedPermissions {
  canAdmin: boolean
  canChat: boolean
  canReadChat: boolean
  canTerminal: boolean
  canReadTerminal: boolean
  canFiles: boolean
  canReadFiles: boolean
  canSpawn: boolean
  canSettings: boolean
  canVoice: boolean
}

export function resolvePermissionFlags(grants: UserGrant[], cwd = '*'): ResolvedPermissions {
  const { permissions, isAdmin } = resolvePermissions(grants, cwd)
  return {
    canAdmin: isAdmin,
    canChat: permissions.has('chat'),
    canReadChat: permissions.has('chat:read'),
    canTerminal: permissions.has('terminal'),
    canReadTerminal: permissions.has('terminal:read'),
    canFiles: permissions.has('files'),
    canReadFiles: permissions.has('files:read'),
    canSpawn: permissions.has('spawn'),
    canSettings: permissions.has('settings'),
    canVoice: permissions.has('voice'),
  }
}

// ─── Grant queries ────────────────────────────────────────────────

export function hasAnyCwdAccess(grants: UserGrant[], cwd: string): boolean {
  const now = Date.now()
  return grants.some(g => isGrantActive(g, now) && matchCwdGlob(g.cwd, cwd))
}

export function allGrantsExpired(grants: UserGrant[]): boolean {
  if (grants.length === 0) return true
  const now = Date.now()
  return grants.every(g => g.notAfter && g.notAfter < now)
}
