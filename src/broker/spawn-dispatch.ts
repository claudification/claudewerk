/**
 * Shared spawn dispatch logic.
 *
 * Single source of truth for "spawn a conversation". Resolves the right
 * backend from the registry and delegates. The Claude path stays inline here
 * (it's the legacy default; Phase 4 of plan-pluggable-backends.md will move
 * it into claudeBackend.spawn but that's a much bigger mechanical PR).
 *
 * Called from:
 * - HTTP `/api/spawn` route (src/broker/routes.ts)
 * - WS `spawn_request` handler (src/broker/handlers/spawn.ts)
 * - WS `channel_spawn` handler (src/broker/handlers/inter-conversation.ts)
 *
 * Every caller has already enforced its own permission/trust check BEFORE
 * invoking dispatchSpawn -- this function does NOT re-check. It trusts the
 * SpawnRequest is valid and the caller is authorized.
 */

import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { generateConversationName } from '../shared/conversation-names'
import { validateModel } from '../shared/models'
import {
  buildProjectUri,
  cwdToProjectUri,
  isSameProject,
  tryParseProjectUri,
  validateProjectUri,
} from '../shared/project-uri'
import type { Conversation, LaunchConfig, ProjectSettings, SpawnResult } from '../shared/protocol'
import { resolveDefaultTransport, resolveSpawnConfig } from '../shared/spawn-defaults'
import { deriveConversationName, validateConversationName } from '../shared/spawn-naming'
import { evaluateSpawnPermission, type SpawnCallerContext } from '../shared/spawn-permissions'
import type { SpawnRequest } from '../shared/spawn-schema'
import { resolveBackendByName, type SpawnDeps } from './backends'
import { dispatchClaudeDaemon } from './backends/claude-daemon'
// Shared spawn-progress emit helper (transport reframe Phase 6 de-duplication).
import { emitLaunchProgress as emitProgress } from './backends/launch-progress'
import type { ConversationStore } from './conversation-store'
import type { GlobalSettings } from './global-settings'

/**
 * Translate the wire-level (`req.profile`, `req.pool`) pair into the
 * persisted `LaunchConfig.sentinelProfile` tagged union (INTENT). The intent
 * round-trips across revive + launch-profile save and feeds the conversation
 * badge UX.
 *
 *  - Absent profile + absent pool   -> undefined (sentinel decides)
 *  - profile = literal name         -> { kind: 'profile', name }
 *                                       (pool is ignored when both are set)
 *  - pool = literal pool name       -> { kind: 'pool', name }
 *
 * Profile and pool are mutually exclusive at the intent layer. The wire
 * accepts both for ergonomics, but profile wins when both are present.
 */
function intentFromProfileField(profile?: string, pool?: string): LaunchConfig['sentinelProfile'] {
  if (profile) return { kind: 'profile', name: profile }
  if (pool) return { kind: 'pool', name: pool }
  return undefined
}

/**
 * Stash the spawn request as `pendingSpawnApproval` on the caller conversation
 * so the panel can render the in-banner approval prompt. Returns the pending
 * dispatch result, or null when no caller is available (handler will fall back
 * to a hard reject) or the caller has the sticky `spawnAutoApproved` bit set
 * (handler should bypass the gate and proceed with dispatch).
 */
// fallow-ignore-next-line complexity
function maybeQueueApproval(req: SpawnRequest, deps: SpawnDispatchDeps, reason: string): SpawnDispatchResult | null {
  const callerConversationId = deps.rendezvousCallerConversationId
  if (!callerConversationId) return null
  const caller = deps.conversationStore.getConversation(callerConversationId)
  if (!caller) return null
  // Sticky auto-approve: caller has previously been granted standing approval.
  if (caller.spawnAutoApproved) return null

  const requestId = randomUUID()
  const requestedAt = Date.now()
  caller.pendingSpawnApproval = {
    requestId,
    requestedAt,
    request: req as unknown as Record<string, unknown>,
    reason,
  }
  caller.pendingAttention = { type: 'spawn_approval', timestamp: requestedAt }
  deps.conversationStore.persistConversationById(callerConversationId)
  deps.conversationStore.broadcastConversationUpdate(callerConversationId)
  console.log(
    `[spawn-approval] pending caller=${callerConversationId.slice(0, 8)} req=${requestId.slice(0, 8)} cwd=${req.cwd ?? '?'} mode=${req.permissionMode ?? 'default'} reason="${reason}"`,
  )
  return {
    ok: false,
    error: "Waiting for user's approval",
    pendingApproval: { requestId, message: "Waiting for user's approval" },
  }
}

export type SpawnDispatchDeps = {
  conversationStore: ConversationStore
  getProjectSettings: (project: string) => ProjectSettings | null
  getGlobalSettings: () => GlobalSettings
  /** Caller context for the unified permission gate. */
  callerContext: SpawnCallerContext
  /** If set, register a rendezvous so the caller conversation is notified when the spawned agent host connects. */
  rendezvousCallerConversationId?: string | null
  /**
   * When true, skip the trust-gate prompt path even if `evaluateSpawnPermission`
   * returns `needs_approval`. Used by the second dispatch that follows a human
   * ALLOW click -- the caller has already been vetted, replaying through the
   * gate would just re-prompt forever.
   *
   * Hard rejects (bypassPermissions, sensitive env) are NOT bypassable. Those
   * fail through this flag too.
   */
  bypassApprovalGate?: boolean
}

export type SpawnDispatchResult =
  | { ok: true; conversationId: string; jobId: string; tmuxSession?: string; project?: string }
  | {
      ok: false
      error: string
      statusCode?: number
      /**
       * Set when the dispatch did not run because the trust gate fired and
       * the broker has stashed the request for human approval. Callers that
       * understand this surface a "Waiting for user's approval" payload to
       * the originating MCP/WS caller; callers that don't simply see
       * `error` like any other deny and surface that.
       */
      pendingApproval?: { requestId: string; message: string }
    }

/**
 * Resolve the transport for a spawn request before it is dispatched.
 * Agent-spawned conversations (MCP `spawn_conversation`, inter-conversation
 * `channel_spawn`) carry no explicit transport -- the global default routes them
 * (`defaultTransport.claude`). Stamps `claude-daemon` up front so the dispatch
 * branch below can route it; the pty/headless transport is finalized later by
 * resolveSpawnConfig (it needs the resolved headless flag). The decision is
 * logged with full context because the transport fork is otherwise a silent
 * branch in the dispatch path (LOG EVERYTHING).
 */
function applyDefaultTransport(req: SpawnRequest, global: GlobalSettings): SpawnRequest {
  const decision = resolveDefaultTransport(req, global)
  console.log(spawnTransportLog(req, global, decision))
  return { ...req, backend: decision.backend, transport: decision.transport }
}

/** The `[spawn-transport]` decision log line (LOG EVERYTHING covenant). */
function spawnTransportLog(
  req: SpawnRequest,
  global: GlobalSettings,
  decision: ReturnType<typeof resolveDefaultTransport>,
): string {
  const explicitBackend = req.backend ?? 'none'
  const explicitTransport = req.transport ?? 'none'
  const globalDefault = global.defaultTransport?.claude ?? '-'
  const resolved = decision.transport ?? '-'
  return (
    `[spawn-transport] cwd=${req.cwd} explicitBackend=${explicitBackend} explicitTransport=${explicitTransport} ` +
    `adHoc=${req.adHoc ? 'y' : 'n'} defaultTransport.claude=${globalDefault} => transport=${resolved} (${decision.reason})`
  )
}

/**
 * Send a spawn request to the right backend. Resolves via the registry; falls
 * back to the legacy inline Claude path if the resolved backend has no
 * `spawn()` method (only true for the Claude backend today).
 *
 * Does NOT enforce permissions - callers must check first. Does NOT validate
 * the SpawnRequest - callers should have parsed it via spawnRequestSchema
 * already.
 */
/**
 * Does `req.cwd` resolve to the same project URI as `callerProject` after the
 * URI normalisation pass (worktree-folded)? Drives the bypass carve-out in
 * `evaluateSpawnPermission`. Path resolution rules:
 *
 *   - explicit URI in cwd               -> compared directly
 *   - absolute path                     -> wrapped with caller's scheme +
 *                                          authority (or `req.sentinel`
 *                                          override when set)
 *   - relative path (`./...`/`../...`)  -> resolved against the caller's
 *                                          project-root path
 *   - tilde or unresolvable             -> false (carve-out skipped; the
 *                                          existing trust gates handle it)
 *   - cross-sentinel via `req.sentinel` -> authorities differ -> false
 *
 * Worktree folding lives at the URI layer (`aliasPath` inside
 * `normalizeProjectUri`), so a target like `<repo>/.claude/worktrees/foo`
 * naturally collapses back to `<repo>` here.
 */
export function computeTargetSameProjectAsCaller(req: SpawnRequest, callerProject: string | null): boolean {
  if (!callerProject) return false
  const cwd = req.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return false
  if (cwd.includes('://')) return isSameProject(callerProject, cwd)
  if (cwd.startsWith('~')) return false

  const callerParsed = tryParseProjectUri(callerProject)
  if (!callerParsed) return false

  const targetAuthority = req.sentinel ?? callerParsed.authority
  const scheme = callerParsed.scheme

  const targetPath = cwd.startsWith('/') ? cwd : path.posix.resolve(callerParsed.path, cwd)
  const targetUri = buildProjectUri({ scheme, authority: targetAuthority, path: targetPath })
  return isSameProject(callerProject, targetUri)
}

export async function dispatchSpawn(rawReq: SpawnRequest, deps: SpawnDispatchDeps): Promise<SpawnDispatchResult> {
  // Resolve the transport up front so the permission gate, the approval-queue
  // stash, and the dispatch branch below all act on the resolved request (an
  // agent-spawned conversation adopts the global `defaultTransport` when it
  // named none explicitly).
  const req = applyDefaultTransport(rawReq, deps.getGlobalSettings())
  // Enrich the caller context with the precomputed same-project flag so the
  // shared gate stays pathless. Callers supply `callerProject` +
  // `callerPermissionMode`; this seam owns the URI resolution.
  const callerContext: SpawnCallerContext = {
    ...deps.callerContext,
    targetSameProjectAsCaller: computeTargetSameProjectAsCaller(req, deps.callerContext.callerProject),
  }
  const evalResult = evaluateSpawnPermission(callerContext, req)
  if (!evalResult.ok) {
    if (evalResult.kind === 'reject') {
      // Hard reject -- not waivable by user approval.
      return { ok: false, error: evalResult.reason, statusCode: 403 }
    }
    // needs_approval: human-in-the-loop dialog path.
    if (!deps.bypassApprovalGate) {
      const pending = maybeQueueApproval(req, deps, evalResult.reason)
      if (pending) return pending
      // Caller conversation missing or already auto-approved -- fall through.
    }
  }

  // FULL DENY for invalid project URIs. We never want a row in the
  // conversation store whose project URI WHATWG URL rejects -- one such row
  // used to poison list_conversations for every benevolent caller (see
  // `parseProjectUri` incident comment). Validate any cwd that LOOKS like a
  // URI attempt (contains `://` or a `scheme:*` wildcard). Absolute paths
  // (`/...`), relative paths (`./...`, `../...`), and home paths (`~/...`)
  // are wrapped by the sentinel via cwdToProjectUri (always safe) and skipped
  // here.
  if (typeof req.cwd === 'string') {
    const looksLikeUri = req.cwd.includes('://') || /^[a-z][a-z0-9+.-]*:/i.test(req.cwd)
    const isPlainPath = req.cwd.startsWith('/') || req.cwd.startsWith('.') || req.cwd.startsWith('~')
    if (looksLikeUri && !isPlainPath) {
      const check = validateProjectUri(req.cwd)
      if (!check.valid) {
        return { ok: false, error: check.error, statusCode: 400 }
      }
    }
  }

  const spawnDeps: SpawnDeps = {
    conversationStore: deps.conversationStore,
    getProjectSettings: deps.getProjectSettings,
    getGlobalSettings: deps.getGlobalSettings,
    // Pass the enriched (same-project flag computed) context downstream so any
    // backend that re-reads it sees the same truth the gate did.
    callerContext,
    rendezvousCallerConversationId: deps.rendezvousCallerConversationId,
  }

  // --- claude-daemon transport --------------------------------------------
  // The daemon is the claude backend's `claude-daemon` transport (it is not a
  // peer backend). Routed by the transport discriminator, NOT `req.backend`.
  let result: SpawnDispatchResult
  if (req.transport === 'claude-daemon') {
    result = await dispatchClaudeDaemon(req, spawnDeps)
  } else if (req.backend) {
    // --- Registry-driven dispatch -----------------------------------------
    // If the requested backend has its own spawn() implementation, delegate.
    // Otherwise fall through to the inline Claude (PTY/headless) path below.
    const backend = resolveBackendByName(req.backend)
    if (!backend) {
      return { ok: false, error: `Unknown backend: ${req.backend}`, statusCode: 400 }
    }
    result = backend.spawn ? await backend.spawn(req, spawnDeps) : await dispatchClaudeSpawn(req, deps)
  } else {
    // --- Inline Claude (PTY/headless) path --------------------------------
    result = await dispatchClaudeSpawn(req, deps)
  }

  // Centralised rendezvous registration: applies to EVERY successful spawn
  // transport. Previously only `dispatchClaudeSpawn` registered, so daemon-
  // and registry-backend spawns lost the caller link at the rendezvous
  // registry -- that's what the Phase 2 KNOWN GAP fix addresses.
  if (result.ok) {
    registerSpawnRendezvous({
      deps,
      conversationId: result.conversationId,
      jobId: result.jobId,
      project: result.project ?? req.cwd,
    })
  }
  return result
}

async function dispatchClaudeSpawn(req: SpawnRequest, deps: SpawnDispatchDeps): Promise<SpawnDispatchResult> {
  // Route to the specified sentinel, or default
  const targetAlias = req.sentinel
  let sentinel: ReturnType<typeof deps.conversationStore.getSentinel>
  let resolvedSentinelId: string | undefined
  if (targetAlias) {
    sentinel = deps.conversationStore.getSentinelByAlias(targetAlias)
    if (!sentinel) {
      const connected = deps.conversationStore.getConnectedSentinels()
      const available = connected.map(s => s.alias).join(', ') || 'none'
      return {
        ok: false,
        error: `Sentinel "${targetAlias}" is offline. Available: ${available}`,
        statusCode: 503,
      }
    }
    const connectedSentinels = deps.conversationStore.getConnectedSentinels()
    resolvedSentinelId = connectedSentinels.find(s => s.alias === targetAlias)?.sentinelId
  } else {
    sentinel = deps.conversationStore.getSentinel()
    if (!sentinel) return { ok: false, error: 'No sentinel connected', statusCode: 503 }
    resolvedSentinelId = deps.conversationStore.getDefaultSentinelId()
  }

  // Pre-flight liveness check: verify sentinel has sent a heartbeat recently.
  // Catches stale/half-open WS connections that would otherwise timeout after 15s.
  if (resolvedSentinelId && !deps.conversationStore.isSentinelAlive(resolvedSentinelId)) {
    return {
      ok: false,
      error: 'Sentinel not responding (no heartbeat received recently)',
      statusCode: 503,
    }
  }

  // Sentinel-profile validation. When `req.profile` is set, confirm the target
  // sentinel actually reported that profile. Unknown -> structured spawn
  // failure with the known list so the caller can correct it. Absent profile
  // passes through (the sentinel does the picking, balanced over all profiles
  // or within `req.pool` if set). The PROFILE-ENV BOUNDARY covenant means the
  // broker validates by NAME only; configDir / env never reach this code path.
  if (req.profile && resolvedSentinelId) {
    const conn = deps.conversationStore.getSentinelConnection(resolvedSentinelId)
    const reported = conn?.profiles
    if (reported && reported.length > 0) {
      const known = new Set(reported.map(p => p.name))
      if (!known.has(req.profile)) {
        const sentinelLabel = targetAlias ?? conn?.alias ?? 'default'
        const known_list = Array.from(known).sort().join(', ') || 'none'
        return {
          ok: false,
          error: `profile "${req.profile}" not configured on sentinel "${sentinelLabel}"; known: ${known_list}`,
          statusCode: 400,
        }
      }
    }
    // If the sentinel never reported any profiles (legacy / no config file),
    // we still forward the name. The sentinel itself will reject unknown names
    // with a structured spawn_result error, so the broker stays permissive
    // rather than gating off a missing identify field.
  }

  // Pool validation. When the target sentinel reports its pool registry,
  // confirm the requested pool exists. Legacy sentinels without a `pools`
  // slice pass through; the sentinel itself falls back to default-pool
  // empty-fallback if needed. Pool is only consulted when profile is absent
  // (profile wins on the wire).
  const requestsPool = req.pool && !req.profile
  if (requestsPool && resolvedSentinelId) {
    const conn = deps.conversationStore.getSentinelConnection(resolvedSentinelId)
    const reportedPools = conn?.pools
    if (reportedPools && reportedPools.length > 0 && req.pool && !reportedPools.includes(req.pool)) {
      const sentinelLabel = targetAlias ?? conn?.alias ?? 'default'
      const known_list = reportedPools.join(', ') || 'none'
      return {
        ok: false,
        error: `pool "${req.pool}" not configured on sentinel "${sentinelLabel}"; known: ${known_list}`,
        statusCode: 400,
      }
    }
  }

  if (req.mode === 'resume' && !req.resumeId) {
    return { ok: false, error: 'resumeId required for resume mode', statusCode: 400 }
  }

  if (req.name) {
    const usedNames = new Set(
      deps.conversationStore
        .getAllConversations()
        .map((s: Conversation) => s.title)
        .filter(Boolean) as string[],
    )
    const nameErr = validateConversationName(req.name, usedNames)
    if (nameErr) return { ok: false, error: nameErr, statusCode: 400 }
  }

  const requestId = randomUUID()
  const conversationId = randomUUID()
  const jobId = req.jobId ?? randomUUID()

  deps.conversationStore.createJob(jobId, conversationId)
  emitProgress(deps.conversationStore, jobId, 'job_created', 'done', { conversationId })

  const projectLabel = req.cwd.split('/').pop() || req.cwd
  if (req.adHoc) {
    console.log(
      `[ad-hoc] Spawn request: ${projectLabel} task=${req.adHocTaskId || 'none'} conv=${conversationId.slice(0, 8)} prompt=${req.prompt?.length || 0}chars worktree=${req.worktree || 'none'}`,
    )
  }

  // Best-effort settings lookup. Non-absolute paths (~/..., ./...) won't match
  // any stored project settings -- that's fine, global defaults apply. The
  // sentinel resolves the real path and returns the canonical URI.
  const settingsUri = req.cwd.includes('://') ? req.cwd : req.cwd.startsWith('/') ? cwdToProjectUri(req.cwd) : null
  const projSettings = settingsUri ? deps.getProjectSettings(settingsUri) : null
  const globalSettings = deps.getGlobalSettings()
  const resolved = resolveSpawnConfig(req, projSettings, globalSettings)
  const {
    headless,
    model,
    effort,
    agent,
    advisor,
    permissionMode,
    autocompactPct,
    maxBudgetUsd,
    bare,
    repl,
    includePartialMessages,
    transport,
  } = resolved

  if (model) {
    const validation = validateModel(model)
    if (!validation.valid) {
      emitProgress(deps.conversationStore, jobId, 'failed', 'error', { error: validation.warning })
      return { ok: false, error: validation.warning || `Unknown model: ${model}`, statusCode: 400 }
    }
  }

  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      deps.conversationStore.removeSpawnListener(requestId)
      reject(new Error('Sentinel did not respond (15s timeout)'))
    }, 15000)

    deps.conversationStore.addSpawnListener(requestId, msg => {
      clearTimeout(timeout)
      resolve(msg as SpawnResult)
    })

    emitProgress(deps.conversationStore, jobId, 'spawn_sent', 'active')

    // Record the resolved config on the job so MCP get_spawn_diagnostics can
    // return it later -- we intentionally drop the prompt (can be large / PII)
    // and the env map (sensitive values live there; diagnostics builder
    // redacts known-secret keys).
    deps.conversationStore.recordJobConfig(jobId, {
      cwd: req.cwd,
      adHoc: req.adHoc,
      adHocTaskId: req.adHocTaskId,
      worktree: req.worktree,
      mkdir: req.mkdir,
      mode: req.adHoc ? 'fresh' : req.mode || 'fresh',
      headless,
      model,
      effort,
      bare,
      repl,
      permissionMode,
      autocompactPct,
      maxBudgetUsd,
      leaveRunning: req.leaveRunning,
      name: req.name,
    })

    deps.conversationStore.setPendingLaunchConfig(conversationId, {
      headless,
      transport,
      model,
      effort,
      agent,
      advisor,
      bare: bare || false,
      repl: repl || false,
      permissionMode,
      autocompactPct,
      includePartialMessages,
      maxBudgetUsd,
      env: req.env || undefined,
      appendSystemPrompt: req.appendSystemPrompt || undefined,
      // Sentinel-profile INTENT (broker-safe NAME / mode / pool only).
      // Profile env stays sentinel-side (PROFILE-ENV BOUNDARY covenant).
      sentinelProfile: intentFromProfileField(req.profile, req.pool),
    })

    try {
      sentinel.send(
        JSON.stringify({
          type: 'spawn',
          requestId,
          cwd: req.cwd,
          conversationId,
          jobId,
          mkdir: req.mkdir || false,
          mode: req.adHoc ? 'fresh' : req.mode || 'fresh',
          resumeId: req.resumeId,
          headless,
          effort,
          model,
          bare: bare || false,
          repl: repl || false,
          conversationName:
            deriveConversationName(req) ??
            generateConversationName(
              new Set(
                deps.conversationStore
                  .getAllConversations()
                  .map((s: Conversation) => s.title)
                  .filter(Boolean) as string[],
              ),
            ),
          conversationDescription: req.description || undefined,
          agent,
          advisor,
          permissionMode,
          autocompactPct,
          maxBudgetUsd,
          prompt: req.prompt || undefined,
          adHoc: req.adHoc || undefined,
          adHocTaskId: req.adHocTaskId || undefined,
          includePartialMessages,
          leaveRunning: req.leaveRunning || undefined,
          worktree: req.worktree || undefined,
          env: req.env || undefined,
          appendSystemPrompt: req.appendSystemPrompt || undefined,
          // Backend-general config injection (transport-reframe Phase 2). The
          // daemon backend reads these via normalizeDaemonReq; the claude
          // PTY/headless path threads them to the agent host (which merges
          // settings + appends mcp-config). settingsPath/mcpConfigPath are
          // top-level SpawnRequest fields, NOT transportMeta -- no boundary read.
          settingsPath: req.settingsPath || undefined,
          mcpConfigPath: req.mcpConfigPath || undefined,
          profile: req.profile || undefined,
          pool: req.pool || undefined,
        }),
      )
    } catch {
      clearTimeout(timeout)
      deps.conversationStore.removeSpawnListener(requestId)
      reject(new Error('Sentinel offline (send failed)'))
      return
    }
  }).catch((err: unknown) => {
    return {
      type: 'spawn_result',
      requestId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    } as SpawnResult
  })

  if (!result.success) {
    const errorMsg = result.error || 'Spawn failed'
    if (req.adHoc) console.log(`[ad-hoc] Spawn FAILED: ${errorMsg} (${projectLabel})`)
    emitProgress(deps.conversationStore, jobId, 'failed', 'error', { error: errorMsg })
    deps.conversationStore.failJob(jobId, errorMsg)
    return { ok: false, error: errorMsg, statusCode: 500 }
  }
  // Sentinel-profile pin: when the sentinel echoes back a resolved profile
  // name, stash it so the boot / meta handler can write it into the
  // conversation's stored projectUri userinfo. The conversation is then
  // permanently bound to that profile (revive reads it from the URI).
  // PROFILE-ENV BOUNDARY: name only -- configDir / env stay sentinel-side.
  if (result.resolvedProfile && typeof result.resolvedProfile === 'string') {
    deps.conversationStore.setPendingResolvedProfile(conversationId, result.resolvedProfile)
    console.log(
      `[spawn-profile] conv=${conversationId.slice(0, 8)} resolvedProfile=${result.resolvedProfile} ` +
        `intent=${req.profile ?? 'default'}`,
    )
  }
  const project = result.project ?? projectLabel
  emitProgress(deps.conversationStore, jobId, 'agent_acked', 'done', { detail: result.tmuxSession })
  if (req.adHoc) console.log(`[ad-hoc] Spawn OK: conv=${conversationId.slice(0, 8)} tmux=${result.tmuxSession}`)

  // Rendezvous registration moved up into `dispatchSpawn` -- this gives ALL
  // transports (claude-daemon, claude-pty, claude-headless) uniform parent
  // capture via the boot-lifecycle's rendezvous lookup. See Phase 2 plan §
  // "KNOWN GAP surfaced for Phase 2" in plan-spawn-parent-tracking.md.

  return { ok: true, conversationId, jobId, tmuxSession: result.tmuxSession, project }
}

/**
 * Register the post-dispatch rendezvous so the caller conversation gets the
 * async `spawn_ready` / `spawn_timeout` push when the spawned agent host
 * connects (or times out). Centralised here so EVERY transport
 * (claude-daemon, claude-pty/headless, registry-driven backends) participates
 * uniformly -- which also means the boot-lifecycle's parent-lineage lookup
 * (`getRendezvousInfo`) works for spawn paths it never reached before.
 *
 * No caller id -> no-op. Spawn flows from non-conversation contexts
 * (dashboard, HTTP without `X-Caller-Conversation`) skip the rendezvous.
 */
function registerSpawnRendezvous(opts: {
  deps: SpawnDispatchDeps
  conversationId: string
  jobId: string
  project: string
}): void {
  const { deps, conversationId, jobId, project } = opts
  const callerConversationId = deps.rendezvousCallerConversationId
  if (!callerConversationId) return
  // Don't block the dispatch return -- caller gets immediate success +
  // conversationId. The rendezvous resolves async via boot-lifecycle's
  // `resolveRendezvous` call (or times out at 120s).
  deps.conversationStore
    .addRendezvous(conversationId, callerConversationId, project, 'spawn')
    .then(conv => {
      emitProgress(deps.conversationStore, jobId, 'conversation_connected', 'done', {
        ccSessionId: (conv.agentHostMeta?.ccSessionId as string) || conv.id,
        conversationId,
      })
      const callerWs = deps.conversationStore.getConversationSocket(callerConversationId)
      callerWs?.send(
        JSON.stringify({
          type: 'spawn_ready',
          ccSessionId: (conv.agentHostMeta?.ccSessionId as string) || conv.id,
          project: conv.project,
          conversationId,
          conv,
        }),
      )
    })
    .catch(err => {
      const errMsg = typeof err === 'string' ? err : 'Spawn rendezvous timed out'
      emitProgress(deps.conversationStore, jobId, 'failed', 'error', { error: errMsg })
      const callerWs = deps.conversationStore.getConversationSocket(callerConversationId)
      callerWs?.send(
        JSON.stringify({
          type: 'spawn_timeout',
          conversationId,
          project,
          error: errMsg,
        }),
      )
    })
}
