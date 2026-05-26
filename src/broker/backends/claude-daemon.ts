/**
 * claude-daemon transport -- claudewerk conversations hosted on a Claude Code
 * daemon worker (subscription-billed), driven by `src/daemon-agent-host/`.
 *
 * The daemon is NOT a peer backend: it is the claude backend's `claude-daemon`
 * transport. `dispatchSpawn` routes here on `req.transport === 'claude-daemon'`
 * (NOT `req.backend`). All daemon launch inputs ride in the opaque
 * `transportMeta` bag -- there are no flat `daemon*` SpawnRequest fields. This
 * file is a backend implementation, so it is the ONLY broker layer allowed to
 * READ `transportMeta` (plan § 0.3, enforced by `lint:boundary`).
 *
 * The broker tags the spawn `agentHostType: 'daemon'` and forwards the resolved
 * daemon config (in a normalized `transportMeta`) to the sentinel, which
 * dispatches (NEW/RESUME) or attaches (ATTACH). From the broker's point of view
 * the daemon-agent-host is an ordinary socket-based agent host -- it sends
 * `agent_host_boot`, transcript entries and terminal data exactly like the
 * Claude agent host.
 *
 * Three launch modes (see `.claude/docs/plan-daemon-launch-ux.md`):
 *   NEW     dispatch a fresh worker + config    -> mint a fresh conversationId
 *   RESUME  dispatch --resume <id> + config     -> mint a fresh conversationId
 *   ATTACH  attach to a roster worker (no spawn) -> REUSE the mirrored row's id
 *
 * The broker persists HOW a daemon conversation was launched into the opaque
 * `agentHostMeta` bag (`DAEMON_META.*` keys) so a later revive can re-apply it.
 */

import { randomUUID } from 'node:crypto'
import { generateConversationName } from '../../shared/conversation-names'
import { cwdToProjectUri } from '../../shared/project-uri'
import type { Conversation, LaunchConfig, SpawnResult as SentinelSpawnResult } from '../../shared/protocol'
import { deriveConversationName, validateConversationName } from '../../shared/spawn-naming'
import type { SpawnRequest } from '../../shared/spawn-schema'
import type { ConversationStore, CreateConversationLineage } from '../conversation-store'
import { computeSpawnLineage } from '../spawn-lineage'
import { emitLaunchProgress } from './launch-progress'
import { awaitSentinelSpawn } from './sentinel-spawn'
import type { SpawnDeps, SpawnResult } from './types'

/** Daemon launch mode -- resolved once, defaults to 'new'. */
type DaemonMode = 'new' | 'resume' | 'attach'

/**
 * The resolved daemon launch config, read from the opaque `transportMeta` bag
 * (plus the promoted top-level `settingsPath`/`mcpConfigPath`/`appendSystemPrompt`
 * for callers that set those backend-general fields). transportMeta is the
 * single source of truth -- there are no flat `daemon*` fields anymore.
 */
export type DaemonConfig = {
  mode: DaemonMode
  resumeSessionId?: string
  attachShort?: string
  settingsPath?: string
  mcpConfigPath?: string
  appendSystemPrompt?: string
}

/**
 * `agentHostMeta` keys this transport owns. The broker core never reads these;
 * only this file reads them back, and `handlers/daemon.ts` writes `short` when
 * it mirrors a roster job. `agentHostMeta` is an opaque bag -- boundary-safe.
 */
export const DAEMON_META = {
  backend: 'backend',
  mode: 'daemonMode',
  settings: 'daemonSettingsPath',
  mcp: 'daemonMcpConfigPath',
  appendPrompt: 'appendSystemPrompt',
  resume: 'daemonResumeSessionId',
  short: 'daemonShort',
  /** Last `ccSessionId` observed for a daemon-hosted conversation at the time
   *  the worker was retired by the daemon. Forensics only -- the broker never
   *  reads this back, just stores it for diag inspection. */
  retiredCcSessionId: 'retiredCcSessionId',
  /** Epoch ms the daemon retired this conversation's worker. Forensics only. */
  retiredAt: 'retiredAt',
} as const

/** Read a string-valued key from the opaque `transportMeta` bag. This file is a
 *  backend implementation -- the ONLY broker layer allowed to read transportMeta
 *  (plan § 0.3, enforced by `lint:boundary`). */
function metaStr(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key]
  return typeof value === 'string' ? value : undefined
}

/** Read the daemon launch mode from `transportMeta`, defaulting to 'new'
 *  (garbage in the opaque bag also falls back to 'new'). */
function metaMode(meta: Record<string, unknown> | undefined): DaemonMode {
  const value = metaStr(meta, 'mode')
  return value === 'resume' || value === 'attach' ? value : 'new'
}

/**
 * Extract the resolved daemon launch config from a SpawnRequest. transportMeta
 * is the single source of truth; the promoted top-level `settingsPath`/
 * `mcpConfigPath`/`appendSystemPrompt` are a fallback for callers that set the
 * backend-general fields rather than the transportMeta slice.
 */
export function readDaemonConfig(req: SpawnRequest): DaemonConfig {
  const tm = req.transportMeta
  return {
    mode: metaMode(tm),
    resumeSessionId: metaStr(tm, 'resumeSessionId'),
    attachShort: metaStr(tm, 'attachShort'),
    settingsPath: metaStr(tm, 'settingsPath') ?? req.settingsPath,
    mcpConfigPath: metaStr(tm, 'mcpConfigPath') ?? req.mcpConfigPath,
    appendSystemPrompt: metaStr(tm, 'appendSystemPrompt') ?? req.appendSystemPrompt,
  }
}

/** Object from [key, value] entries, dropping falsy values. Data-driven so the
 *  config builders below stay branch-free (low cyclomatic). */
function compact(entries: Array<[string, unknown]>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of entries) if (value) out[key] = value
  return out
}

/**
 * Mode-specific required-field check. Returns an error string, or null when the
 * request is valid. `refineTransportSpawn` enforces the same at the
 * request-validation boundary; this guards non-HTTP callers (the MCP spawn tool
 * validates against the bare object schema, which has no cross-field refinement).
 *
 * NEW mode requires nothing -- promptless NEW dispatch is supported (Phase 4
 * socket dispatch P1 + Phase 5 UI relabel). Only RESUME/ATTACH carry a required
 * field.
 */
export function validateDaemonModeFields(_req: SpawnRequest, cfg: DaemonConfig): string | null {
  // Per mode: [human label for the error, the field that must be non-empty].
  // NEW has no required field (value undefined -> treated as satisfied below).
  const required: Record<DaemonMode, [string, string | undefined]> = {
    new: ['', undefined],
    resume: ['transportMeta.resumeSessionId', cfg.resumeSessionId],
    attach: ['transportMeta.attachShort', cfg.attachShort],
  }
  const [label, value] = required[cfg.mode]
  if (!label) return null // NEW -- nothing required
  return value?.trim() ? null : `claude-daemon spawn (${cfg.mode} mode) requires ${label}`
}

/** Read the daemon worker short the roster mirror stored on a conversation. */
function readDaemonShort(conv: Conversation): string | undefined {
  const value = conv.agentHostMeta?.[DAEMON_META.short]
  return typeof value === 'string' ? value : undefined
}

/**
 * Find the roster-mirrored daemon conversation for a worker `short`. ATTACH
 * reuses this conversationId rather than minting a duplicate row -- attaching
 * is "take over an observed session", not "create a new conversation".
 */
export function findDaemonConversationByShort(deps: SpawnDeps, short: string): Conversation | undefined {
  return deps.conversationStore
    .getAllConversations()
    .find(c => c.agentHostType === 'daemon' && readDaemonShort(c) === short)
}

/**
 * Build the daemon launch-config metadata persisted on the conversation, so a
 * later revive can re-apply the same launch. Merges over any existing meta
 * (the daemon-agent-host's `agent_host_boot` adds ccSessionId later). ATTACH
 * injects no config -- the worker was already configured by whoever ran it.
 */
export function buildDaemonLaunchMeta(
  cfg: DaemonConfig,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  // ATTACH injects no config -- the worker was already configured. NEW/RESUME
  // record the injected config; RESUME also records the resumed session id.
  const injected =
    cfg.mode === 'attach'
      ? {}
      : compact([
          [DAEMON_META.settings, cfg.settingsPath],
          [DAEMON_META.mcp, cfg.mcpConfigPath],
          [DAEMON_META.appendPrompt, cfg.appendSystemPrompt],
          [DAEMON_META.resume, cfg.mode === 'resume' ? cfg.resumeSessionId : undefined],
        ])
  return { ...existing, [DAEMON_META.backend]: 'daemon', [DAEMON_META.mode]: cfg.mode, ...injected }
}

/**
 * Build the typed `LaunchConfig` for a daemon conversation. This is the
 * control-panel-facing "how was this launched" record (the read-only Launch
 * config block). The web reads these TYPED display fields, never the opaque
 * `transportMeta` bag (boundary rule). ATTACH injected no config -- it records
 * only the mode. The resume-from session id is deliberately NOT surfaced here
 * (session-shaped; boundary rule).
 */
export function buildDaemonLaunchConfig(req: SpawnRequest, cfg: DaemonConfig): LaunchConfig {
  // ATTACH injects no config -- the worker was already configured.
  const injected =
    cfg.mode === 'attach'
      ? {}
      : compact([
          ['daemonSettingsPath', cfg.settingsPath],
          ['daemonMcpConfigPath', cfg.mcpConfigPath],
          ['appendSystemPrompt', cfg.appendSystemPrompt],
          ['env', req.env],
        ])
  const base = { headless: false, agentHostType: 'daemon', daemonMode: cfg.mode, transport: 'claude-daemon' }
  return { ...base, ...compact([['model', req.model]]), ...injected } as LaunchConfig
}

/** One-line summary of the config flags a NEW/RESUME spawn injects. */
function describeDaemonConfig(req: SpawnRequest, cfg: DaemonConfig): string {
  const envCount = req.env ? Object.keys(req.env).length : 0
  const labels = Object.keys(
    compact([
      ['+settings', cfg.settingsPath],
      ['+mcp', cfg.mcpConfigPath],
      ['+sysprompt', cfg.appendSystemPrompt],
      [`+${envCount}env`, envCount],
    ]),
  )
  return labels.length > 0 ? ` ${labels.join(' ')}` : ''
}

/**
 * Dispatch a `claude-daemon` transport spawn. Folded from the former
 * `backends/daemon.ts` (transport reframe Phase 6): keyed on
 * `transport === 'claude-daemon'`, transportMeta as the single config source.
 */
export async function dispatchClaudeDaemon(req: SpawnRequest, deps: SpawnDeps): Promise<SpawnResult> {
  const cfg = readDaemonConfig(req)
  const pre = preflightDaemonSpawn(req, deps, cfg)
  if (!pre.ok) return pre.error
  const { sentinel, usedNames } = pre

  const requestId = randomUUID()
  const jobId = req.jobId ?? randomUUID()
  const id = resolveDaemonIdentity(req, deps, cfg, usedNames)
  const { conversationId, conversationName, project } = id

  console.log(daemonDispatchLog(req, cfg, conversationId, jobId, id.reused))
  deps.conversationStore.createJob(jobId, conversationId)
  emitLaunchProgress(deps.conversationStore, jobId, 'job_created', 'done', { conversationId })

  const result = await dispatchToSentinel({
    sentinel,
    deps,
    req,
    cfg,
    requestId,
    conversationId,
    jobId,
    conversationName,
  })
  if (!result.success) return failDaemonSpawn(deps, { jobId, conversationId, mode: cfg.mode, error: result.error })

  finalizeDaemonConversation(deps, { conversationId, project, conversationName, req, cfg, result })
  emitLaunchProgress(deps.conversationStore, jobId, 'agent_acked', 'done')
  return { ok: true, conversationId, jobId, tmuxSession: result.tmuxSession, project }
}

/** Record a daemon dispatch failure (log + progress event + job fail) and
 *  return the 500 SpawnResult. */
function failDaemonSpawn(
  deps: SpawnDeps,
  opts: { jobId: string; conversationId: string; mode: DaemonMode; error?: string; sentinelAlias?: string },
): SpawnResult {
  const errorMsg = opts.error || 'Spawn failed'
  console.warn(
    `[daemon-spawn] FAILED jobId=${opts.jobId.slice(0, 8)} mode=${opts.mode} ` +
      `conv=${opts.conversationId.slice(0, 8)} sentinel=${opts.sentinelAlias ?? '-'} ` +
      `statusCode=500: ${errorMsg}`,
  )
  emitLaunchProgress(deps.conversationStore, opts.jobId, 'failed', 'error', { error: errorMsg })
  deps.conversationStore.failJob(opts.jobId, errorMsg)
  return { ok: false, error: errorMsg, statusCode: 500 }
}

/** Validate the requested conversation name against the in-use set. Returns a
 *  400 SpawnResult on conflict, else null. */
function daemonNameError(req: SpawnRequest, usedNames: Set<string>): SpawnResult | null {
  if (!req.name) return null
  const nameErr = validateConversationName(req.name, usedNames)
  return nameErr ? { ok: false, error: nameErr, statusCode: 400 } : null
}

/** Mode validation + sentinel resolution + liveness + name check, up front. */
function preflightDaemonSpawn(
  req: SpawnRequest,
  deps: SpawnDeps,
  cfg: DaemonConfig,
):
  | { ok: true; sentinel: NonNullable<ReturnType<ConversationStore['getSentinel']>>; usedNames: Set<string> }
  | {
      ok: false
      error: SpawnResult
    } {
  const modeErr = validateDaemonModeFields(req, cfg)
  if (modeErr) return { ok: false, error: { ok: false, error: modeErr, statusCode: 400 } }

  const sr = resolveLiveSentinel(req, deps)
  if (!sr.ok) return { ok: false, error: sr.error }

  const usedNames = new Set(
    deps.conversationStore
      .getAllConversations()
      .map(s => s.title)
      .filter(Boolean) as string[],
  )
  const nameErr = daemonNameError(req, usedNames)
  if (nameErr) return { ok: false, error: nameErr }
  return { ok: true, sentinel: sr.sentinel, usedNames }
}

/** Resolve the target sentinel AND assert it has a recent heartbeat -- the two
 *  pre-flight sentinel checks as one decision (offline alias -> 503, stale
 *  heartbeat -> 503). */
function resolveLiveSentinel(req: SpawnRequest, deps: SpawnDeps): SentinelResolution {
  const sr = resolveSentinel(req, deps)
  if (!sr.ok) return sr
  const stale = sentinelLivenessError(sr.resolvedSentinelId, deps)
  return stale ? { ok: false, error: stale } : sr
}

/** Pre-flight liveness: 503 when the resolved sentinel has no recent heartbeat. */
function sentinelLivenessError(resolvedSentinelId: string | undefined, deps: SpawnDeps): SpawnResult | null {
  if (resolvedSentinelId && !deps.conversationStore.isSentinelAlive(resolvedSentinelId)) {
    return { ok: false, error: 'Sentinel not responding (no heartbeat received recently)', statusCode: 503 }
  }
  return null
}

/** ATTACH reuses an already-mirrored roster conversation; NEW/RESUME mint a
 *  fresh one. Returns the mirror row to reuse, or undefined. */
function resolveDaemonReuse(deps: SpawnDeps, cfg: DaemonConfig): Conversation | undefined {
  return cfg.mode === 'attach' && cfg.attachShort ? findDaemonConversationByShort(deps, cfg.attachShort) : undefined
}

/** Conversation name: an explicit derived name, else the reused row's title,
 *  else a fresh generated name. */
function daemonConversationName(req: SpawnRequest, usedNames: Set<string>, reusedTitle?: string): string {
  return deriveConversationName(req) ?? reusedTitle ?? generateConversationName(usedNames)
}

/** Resolve the conversation id / name / project for a daemon spawn. ATTACH
 *  reuses the mirror row's identity; NEW/RESUME mint a fresh one. */
function resolveDaemonIdentity(
  req: SpawnRequest,
  deps: SpawnDeps,
  cfg: DaemonConfig,
  usedNames: Set<string>,
): { reused: boolean; conversationId: string; conversationName: string; project: string } {
  const reused = resolveDaemonReuse(deps, cfg)
  if (reused) {
    return {
      reused: true,
      conversationId: reused.id,
      conversationName: daemonConversationName(req, usedNames, reused.title),
      project: reused.project,
    }
  }
  return {
    reused: false,
    conversationId: randomUUID(),
    conversationName: daemonConversationName(req, usedNames),
    project: cwdToProjectUri(req.cwd),
  }
}

/** One-line dispatch log (LOG EVERYTHING): mode, ids, sentinel, reuse + config.
 *  The resume-from / attach-short detail rides the sentinel dispatch log. */
function daemonDispatchLog(
  req: SpawnRequest,
  cfg: DaemonConfig,
  conversationId: string,
  jobId: string,
  reused: boolean,
): string {
  const config = cfg.mode === 'attach' ? '' : describeDaemonConfig(req, cfg)
  return (
    `[daemon-spawn] dispatch mode=${cfg.mode} conv=${conversationId.slice(0, 8)} job=${jobId.slice(0, 8)} ` +
    `sentinel=${req.sentinel ?? 'default'} reusedConv=${reused ? 'yes' : 'no'}${config}`
  )
}

/**
 * Pre-tag the conversation so boot/input messages route to this transport
 * before the daemon-agent-host's agent_host_boot arrives and fills the rest.
 */
function finalizeDaemonConversation(
  deps: SpawnDeps,
  opts: {
    conversationId: string
    project: string
    conversationName: string
    req: SpawnRequest
    cfg: DaemonConfig
    result: SentinelSpawnResult
  },
): void {
  const { conversationId, project, conversationName, req, cfg, result } = opts
  // Phase 2 spawn-parent-tracking: capture parent + root on FIRST persistence.
  // Daemon's `getOrCreateDaemonConversation` runs at finalize time (BEFORE the
  // daemon-agent-host's agent_host_boot), so the boot-lifecycle's rendezvous
  // lookup would miss it -- we plumb the caller id from deps directly here.
  // ATTACH reuses an existing roster row -- lineage is preserved untouched.
  const lineage = computeSpawnLineage(
    deps.conversationStore,
    deps.rendezvousCallerConversationId,
    conversationId,
    'daemon',
  )
  const conv = getOrCreateDaemonConversation(deps, conversationId, project, req.model, lineage)
  const statusBefore = conv.status
  conv.agentHostType = 'daemon'
  conv.transport = 'claude-daemon'
  conv.agentHostMeta = buildDaemonLaunchMeta(cfg, conv.agentHostMeta)
  // The typed, control-panel-facing launch record (read-only Launch config
  // block). Separate from the opaque agentHostMeta revive bag above.
  conv.launchConfig = buildDaemonLaunchConfig(req, cfg)
  conv.project = project
  conv.title = req.name || conversationName
  if (req.description) conv.description = req.description
  // ATTACH reactivates a previously read-only / ended roster mirror row.
  if (conv.status === 'ended') conv.endedBy = undefined
  deps.conversationStore.persistConversationById(conversationId)

  console.log(daemonOkLog(cfg, conversationId, statusBefore, result))
}

/** One-line success log (LOG EVERYTHING): mode, conv, the status the row had
 *  before tagging, and the tmux session the sentinel reported. */
function daemonOkLog(
  cfg: DaemonConfig,
  conversationId: string,
  statusBefore: string,
  result: SentinelSpawnResult,
): string {
  return (
    `[daemon-spawn] OK mode=${cfg.mode} conv=${conversationId.slice(0, 8)} statusBefore=${statusBefore} ` +
    `tmux=${result.tmuxSession ?? 'none'} launchConfig=persisted`
  )
}

/** The conversation row to tag -- the existing one (revive / roster mirror) or
 *  a freshly-created terminal-capable row. Lineage is passed through to the
 *  CREATE path only; revive/ATTACH paths preserve whatever was persisted on the
 *  first INSERT (plan § 3 Phase 2 #7: idempotency). */
function getOrCreateDaemonConversation(
  deps: SpawnDeps,
  conversationId: string,
  project: string,
  model: string | undefined,
  lineage: CreateConversationLineage | undefined,
): Conversation {
  return (
    deps.conversationStore.getConversation(conversationId) ??
    deps.conversationStore.createConversation(conversationId, project, model || '', [], ['terminal'], lineage)
  )
}

type SentinelResolution =
  | { ok: true; sentinel: NonNullable<ReturnType<ConversationStore['getSentinel']>>; resolvedSentinelId?: string }
  | { ok: false; error: SpawnResult }

/** Resolve an explicitly-named sentinel by alias (offline -> structured error). */
function resolveAliasSentinel(alias: string, deps: SpawnDeps): SentinelResolution {
  const sentinel = deps.conversationStore.getSentinelByAlias(alias)
  if (!sentinel) {
    const available = deps.conversationStore
      .getConnectedSentinels()
      .map(s => s.alias)
      .join(', ')
    const error = `Sentinel "${alias}" is offline. Available: ${available || 'none'}`
    return { ok: false, error: { ok: false, error, statusCode: 503 } }
  }
  const resolvedSentinelId = deps.conversationStore.getConnectedSentinels().find(s => s.alias === alias)?.sentinelId
  return { ok: true, sentinel, resolvedSentinelId }
}

/** Resolve the target sentinel for this spawn (explicit alias or the default). */
function resolveSentinel(req: SpawnRequest, deps: SpawnDeps): SentinelResolution {
  if (req.sentinel) return resolveAliasSentinel(req.sentinel, deps)
  const sentinel = deps.conversationStore.getSentinel()
  if (!sentinel) return { ok: false, error: { ok: false, error: 'No sentinel connected', statusCode: 503 } }
  return { ok: true, sentinel, resolvedSentinelId: deps.conversationStore.getDefaultSentinelId() }
}

/** The normalized daemon config bag the sentinel reads. ATTACH carries only the
 *  worker short (no config injection); NEW/RESUME carry the injected config. */
function buildDaemonTransportMeta(cfg: DaemonConfig): Record<string, unknown> {
  if (cfg.mode === 'attach') return { mode: 'attach', attachShort: cfg.attachShort }
  return {
    mode: cfg.mode,
    ...compact([
      ['resumeSessionId', cfg.mode === 'resume' ? cfg.resumeSessionId : undefined],
      ['settingsPath', cfg.settingsPath],
      ['mcpConfigPath', cfg.mcpConfigPath],
      ['appendSystemPrompt', cfg.appendSystemPrompt],
    ]),
  }
}

/**
 * Build the `spawn` payload sent to the sentinel. NEW/RESUME carry the prompt
 * and config injection; ATTACH carries only the roster short (no spawn, no
 * config -- the worker is already configured). The daemon launch inputs ride in
 * a NORMALIZED `transportMeta` -- the sentinel reads only `transportMeta.*`, not
 * any flat `daemon*` field.
 */
export function buildSentinelSpawnMessage(opts: {
  req: SpawnRequest
  cfg: DaemonConfig
  requestId: string
  conversationId: string
  jobId: string
  conversationName: string
}): Record<string, unknown> {
  const { req, cfg, requestId, conversationId, jobId, conversationName } = opts
  return {
    type: 'spawn',
    requestId,
    conversationId,
    jobId,
    // The sentinel routes daemon-tagged spawns to its daemon dispatch path.
    agentHostType: 'daemon',
    transport: 'claude-daemon',
    transportMeta: buildDaemonTransportMeta(cfg),
    cwd: req.cwd,
    mkdir: req.mkdir || false,
    mode: req.mode || 'fresh',
    conversationName,
    // ATTACH attaches to an already-running worker -- no first-turn prompt.
    ...compact([
      ['model', req.model],
      ['conversationDescription', req.description],
      ['env', req.env],
      ['prompt', cfg.mode === 'attach' ? undefined : req.prompt],
    ]),
  }
}

/** Send the spawn message to the sentinel and await its spawn_result. The
 *  listener/timeout handshake is shared with the OpenCode backend
 *  (`awaitSentinelSpawn`); only the message + pre-send progress differ. */
function dispatchToSentinel(opts: {
  sentinel: NonNullable<ReturnType<ConversationStore['getSentinel']>>
  deps: SpawnDeps
  req: SpawnRequest
  cfg: DaemonConfig
  requestId: string
  conversationId: string
  jobId: string
  conversationName: string
}): Promise<SentinelSpawnResult> {
  const { sentinel, deps, req, cfg, requestId, conversationId, jobId } = opts
  return awaitSentinelSpawn(deps.conversationStore, requestId, () => {
    emitLaunchProgress(deps.conversationStore, jobId, 'spawn_sent', 'active')
    deps.conversationStore.recordJobConfig(jobId, {
      cwd: req.cwd,
      worktree: req.worktree,
      mkdir: req.mkdir,
      mode: req.mode || 'fresh',
      headless: true,
      model: req.model,
      bare: false,
      repl: false,
      name: req.name,
    })
    sentinel.send(JSON.stringify(buildSentinelSpawnMessage(opts)))
    console.log(
      `[daemon-spawn] spawn message sent to sentinel mode=${cfg.mode} conv=${conversationId.slice(0, 8)} ` +
        `req=${requestId.slice(0, 8)}`,
    )
  })
}
