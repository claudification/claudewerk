/**
 * Unified spawn permission gate.
 *
 * Single source of truth for the cross-transport (HTTP / WS / MCP) checks
 * that every spawn path must agree on. Callers translate their native
 * auth/trust signals into a `SpawnCallerContext` and let this module decide.
 *
 * Base rule: spawn permission is always required.
 * MCP rule: the MCP caller's own project must be `benevolent`.
 * Field rules:
 *   - `permissionMode: 'bypassPermissions'` requires `benevolent` trust
 *   - Overrides of sensitive env keys require `benevolent` trust
 */

import type { SpawnRequest } from './spawn-schema'

export type TrustLevel = 'untrusted' | 'trusted' | 'benevolent'

export type SpawnCallerKind = 'http' | 'ws' | 'mcp'

export type SpawnCallerContext = {
  kind: SpawnCallerKind
  hasSpawnPermission: boolean
  trustLevel: TrustLevel
  /** Caller's own project URI, for MCP cross-project trust checks. null for dashboard callers. */
  callerProject: string | null
  /**
   * Caller conversation's current CC permission mode (e.g. 'bypassPermissions').
   * Read from `Conversation.permissionMode`. Used by the same-project bypass
   * carve-out: a caller already running with `bypassPermissions` has been
   * granted "skip the gates within its scope" by the human, and a spawn into
   * its own project (or a worktree of it) stays inside that scope.
   */
  callerPermissionMode?: string
  /**
   * Precomputed by the dispatch seam: does `req.cwd` resolve to the same
   * project URI as `callerProject` after worktree-folding? `aliasPath`
   * collapses `/.claude/worktrees/<name>` segments at the URI parse layer,
   * so a worktree target shares a project URI with its parent repo. Used
   * exclusively by the bypass carve-out; never set for dashboard callers.
   */
  targetSameProjectAsCaller?: boolean
}

/** Thrown when spawn is denied. Callers map to HTTP 403 / WS error reply. */
export class SpawnPermissionError extends Error {
  field: string | undefined
  required: TrustLevel | 'spawn_permission'
  constructor(message: string, field?: string, required: TrustLevel | 'spawn_permission' = 'spawn_permission') {
    super(message)
    this.name = 'SpawnPermissionError'
    this.field = field
    this.required = required
  }
}

const SENSITIVE_ENV_KEYS: ReadonlySet<string> = new Set([
  'HOME',
  'PATH',
  'USER',
  'SHELL',
  'LOGNAME',
  'SUDO_USER',
  'ANTHROPIC_API_KEY',
])

/**
 * Typed result for {@link evaluateSpawnPermission}. Three outcomes:
 *
 * - `{ ok: true }` -- proceed with dispatch.
 * - `{ kind: 'reject', ... }` -- HARD deny. The caller must surface an error.
 *   Reserved for failures the human cannot waive: missing spawn permission,
 *   bypassPermissions without benevolent trust, sensitive env overrides.
 * - `{ kind: 'needs_approval', ... }` -- the trust gate would have blocked,
 *   but the human can override via the in-panel approval prompt. The dispatch
 *   layer writes `pendingSpawnApproval` onto the caller conversation and
 *   returns to the wire with `pending: true`.
 */
export type SpawnEvalResult =
  | { ok: true }
  | { ok: false; kind: 'reject'; reason: string; field?: string; required: TrustLevel | 'spawn_permission' }
  | { ok: false; kind: 'needs_approval'; reason: string }

/**
 * Pure permission evaluation. No side effects, no throws -- callers branch on
 * the discriminated result. Use this in dispatch paths that need to distinguish
 * "block forever" from "ask the human".
 *
 * Cyclomatic load is the four orthogonal trust gates (spawn permission,
 * bypassPermissions, sensitive env, MCP-from-non-benevolent). Splitting them
 * into separate helpers buys nothing -- each gate is a single comparison and
 * the order matters for the returned reason. Keep the linear shape.
 */
// fallow-ignore-next-line complexity
export function evaluateSpawnPermission(ctx: SpawnCallerContext, req: SpawnRequest): SpawnEvalResult {
  if (!ctx.hasSpawnPermission) {
    return {
      ok: false,
      kind: 'reject',
      reason: 'Spawn permission required',
      required: 'spawn_permission',
    }
  }
  // Same-project bypass carve-out. A caller already running with
  // `permissionMode='bypassPermissions'` that spawns into its own project
  // (or a worktree of it -- aliasPath folds worktree paths back to the
  // parent repo in isSameProject) skips every downstream gate: the
  // benevolent-trust requirement, sensitive-env rejection, AND the MCP
  // approval prompt. The caller has been granted scope-wide bypass by the
  // human; a sibling spawn inside that scope changes no trust boundary.
  // Cross-project, cross-sentinel, and non-bypass callers still hit the
  // gates below. Dashboard callers leave the new fields undefined and
  // fall through unchanged.
  if (ctx.callerPermissionMode === 'bypassPermissions' && ctx.targetSameProjectAsCaller) {
    return { ok: true }
  }
  // bypassPermissions and sensitive env are HARD rejects -- the human cannot
  // waive these via the approval dialog. They imply the caller wants to do
  // something the trust system explicitly says only benevolent callers may do.
  if (req.permissionMode === 'bypassPermissions' && ctx.trustLevel !== 'benevolent') {
    return {
      ok: false,
      kind: 'reject',
      reason: 'bypassPermissions mode requires benevolent trust',
      field: 'permissionMode',
      required: 'benevolent',
    }
  }
  if (req.env) {
    for (const key of Object.keys(req.env)) {
      if (SENSITIVE_ENV_KEYS.has(key) && ctx.trustLevel !== 'benevolent') {
        return {
          ok: false,
          kind: 'reject',
          reason: `Override of sensitive env "${key}" requires benevolent trust`,
          field: 'env',
          required: 'benevolent',
        }
      }
    }
  }
  // The MCP-from-non-benevolent gate is the ONLY one a human can waive.
  // Returning needs_approval lets the dispatcher write a pendingSpawnApproval
  // record and surface the in-panel prompt instead of failing outright.
  if (ctx.kind === 'mcp' && ctx.trustLevel !== 'benevolent') {
    return {
      ok: false,
      kind: 'needs_approval',
      reason: 'Spawn via MCP from a non-benevolent caller requires user approval',
    }
  }
  return { ok: true }
}

/**
 * Unified spawn gate. Throws SpawnPermissionError on deny.
 *
 * Treats both `reject` and `needs_approval` as throws -- this is the legacy
 * surface used by tests and any caller that still wants the throw-on-deny
 * shape. New code should call {@link evaluateSpawnPermission} directly so it
 * can branch on `needs_approval` and surface the human-in-the-loop prompt.
 */
export function assertSpawnAllowed(ctx: SpawnCallerContext, req: SpawnRequest): void {
  const result = evaluateSpawnPermission(ctx, req)
  if (result.ok) return
  if (result.kind === 'needs_approval') {
    // Legacy callers see the same "MCP requires benevolent" message they used
    // to see, so existing error rendering keeps working.
    throw new SpawnPermissionError('Spawn via MCP requires benevolent trust on caller project', undefined, 'benevolent')
  }
  throw new SpawnPermissionError(result.reason, result.field, result.required)
}

/**
 * Map the wire-level `ProjectSettings.trustLevel` ('default' | 'open' | 'benevolent' | undefined)
 * to the internal {@link TrustLevel} used by {@link assertSpawnAllowed}.
 *
 * - `benevolent` stays `benevolent`
 * - everything else collapses to `trusted` (dashboard default)
 * - `untrusted` is reserved for callers that want to deny by default
 *   (pass `'untrusted'` explicitly, e.g. guest/share sessions)
 */
export function mapProjectTrust(trust: 'default' | 'open' | 'benevolent' | undefined): TrustLevel {
  if (trust === 'benevolent') return 'benevolent'
  return 'trusted'
}
