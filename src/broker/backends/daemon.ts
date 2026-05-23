/**
 * Daemon backend -- claudewerk conversations hosted on a Claude Code daemon
 * worker (subscription-billed), driven by `src/daemon-agent-host/`.
 *
 * The dashboard requests `backend: 'daemon'` with a `daemonMode`. The broker
 * tags the spawn `agentHostType: 'daemon'` and forwards the mode + config to
 * the sentinel, which dispatches (NEW/RESUME) or attaches (ATTACH). From the
 * broker's point of view the daemon-agent-host is an ordinary socket-based
 * agent host -- it sends `agent_host_boot`, transcript entries and terminal
 * data exactly like the Claude agent host.
 *
 * Three launch modes (see `.claude/docs/plan-daemon-launch-ux.md`):
 *   NEW     claude --bg <prompt> + config       -> mint a fresh conversationId
 *   RESUME  claude --bg --resume <id> + config  -> mint a fresh conversationId
 *   ATTACH  attach to a roster worker (no --bg) -> REUSE the mirrored row's id
 *
 * The broker persists HOW a daemon conversation was launched into the opaque
 * `agentHostMeta` bag (`DAEMON_META.*` keys) so a later revive can re-apply it.
 * This file is the only reader of those keys; the broker core never interprets
 * them -- boundary-safe.
 */

import { randomUUID } from 'node:crypto'
import { generateConversationName } from '../../shared/conversation-names'
import { cwdToProjectUri } from '../../shared/project-uri'
import type {
  Conversation,
  LaunchConfig,
  LaunchProgressEvent,
  LaunchStep,
  SpawnResult as SentinelSpawnResult,
} from '../../shared/protocol'
import { deriveConversationName, validateConversationName } from '../../shared/spawn-naming'
import type { SpawnRequest } from '../../shared/spawn-schema'
import type { ConversationStore } from '../conversation-store'
import type { ConversationBackend, InputResult, SpawnDeps, SpawnResult } from './types'

/** Daemon launch mode -- resolved once, defaults to 'new'. */
type DaemonMode = 'new' | 'resume' | 'attach'

/**
 * `agentHostMeta` keys this backend owns. The broker core never reads these;
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

/** Read the daemon launch mode from `transportMeta`, accepting only the three
 *  valid modes (garbage in the opaque bag falls back to the legacy field). */
function metaMode(meta: Record<string, unknown> | undefined): DaemonMode | undefined {
  const value = metaStr(meta, 'mode')
  return value === 'new' || value === 'resume' || value === 'attach' ? value : undefined
}

/**
 * Dual-read normalization for the transport reframe (Phase 1). The NEW spawn
 * shape carries the daemon launch inputs in `transportMeta` (plus the promoted
 * top-level `settingsPath`/`mcpConfigPath`); the LEGACY shape carries flat
 * `daemon*` fields. Prefer the new shape when present, fall back to the legacy
 * fields, and return a request whose flat fields are populated so the rest of
 * this backend (which reads the flat fields) works unchanged. A no-op when no
 * `transportMeta` is present (pure legacy callers). See plan § 0.3 / Phase 1.
 */
export function normalizeDaemonReq(req: SpawnRequest): SpawnRequest {
  const tm = req.transportMeta
  if (!tm) return req
  return {
    ...req,
    daemonMode: metaMode(tm) ?? req.daemonMode,
    daemonResumeSessionId: metaStr(tm, 'resumeSessionId') ?? req.daemonResumeSessionId,
    daemonAttachShort: metaStr(tm, 'attachShort') ?? req.daemonAttachShort,
    daemonSettingsPath: metaStr(tm, 'settingsPath') ?? req.settingsPath ?? req.daemonSettingsPath,
    daemonMcpConfigPath: metaStr(tm, 'mcpConfigPath') ?? req.mcpConfigPath ?? req.daemonMcpConfigPath,
    appendSystemPrompt: metaStr(tm, 'appendSystemPrompt') ?? req.appendSystemPrompt,
  }
}

function emitProgress(
  conversationStore: ConversationStore,
  jobId: string | undefined,
  step: LaunchStep,
  status: LaunchProgressEvent['status'],
  extra?: Partial<LaunchProgressEvent>,
): void {
  if (!jobId) return
  conversationStore.forwardJobEvent(jobId, { type: 'launch_progress', jobId, step, status, t: Date.now(), ...extra })
}

export const daemonBackend: ConversationBackend = {
  type: 'daemon',
  scheme: 'daemon',
  // bin/daemon-host connects back to the broker over a per-conversation
  // WebSocket, exactly like the Claude and OpenCode agent hosts.
  requiresAgentSocket: true,

  async spawn(req: SpawnRequest, deps: SpawnDeps): Promise<SpawnResult> {
    return spawnDaemon(req, deps)
  },

  async handleInput(): Promise<InputResult> {
    // Same contract as the Claude backend: input is forwarded over the agent
    // host socket by the unified send_input handler (the daemon-agent-host
    // writes it to the worker PTY).
    return { ok: false, useSocket: true, error: 'Daemon input is handled via the agent host socket' }
  },
}

/**
 * Mode-specific required-field check. `refineDaemonSpawn` enforces the same at
 * the request-validation boundary; this guards non-HTTP callers (the MCP spawn
 * tool validates against the bare object schema, which has no cross-field
 * refinement). Returns an error string, or null when the request is valid.
 */
export function validateDaemonModeFields(req: SpawnRequest, mode: DaemonMode): string | null {
  // Per mode: [human label for the error, the field that must be non-empty].
  const required: Record<DaemonMode, [string, string | undefined]> = {
    new: ['an initial prompt', req.prompt],
    resume: ['daemonResumeSessionId', req.daemonResumeSessionId],
    attach: ['daemonAttachShort', req.daemonAttachShort],
  }
  const [label, value] = required[mode]
  return value?.trim() ? null : `Daemon spawn (${mode} mode) requires ${label}`
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
  req: SpawnRequest,
  mode: DaemonMode,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...existing, [DAEMON_META.backend]: 'daemon', [DAEMON_META.mode]: mode }
  // ATTACH injects no config -- the worker was already configured. NEW/RESUME
  // record the injected config; RESUME also records the resumed session id.
  const pairs: Array<[string, string | undefined]> = []
  if (mode !== 'attach') {
    pairs.push(
      [DAEMON_META.settings, req.daemonSettingsPath],
      [DAEMON_META.mcp, req.daemonMcpConfigPath],
      [DAEMON_META.appendPrompt, req.appendSystemPrompt],
    )
  }
  if (mode === 'resume') pairs.push([DAEMON_META.resume, req.daemonResumeSessionId])
  for (const [key, value] of pairs) {
    if (value) meta[key] = value
  }
  return meta
}

/**
 * Build the typed `LaunchConfig` for a daemon conversation. This is the
 * control-panel-facing "how was this launched" record (the read-only Launch
 * config block); `buildDaemonLaunchMeta` is the opaque revive bag. ATTACH
 * injected no config -- it records only the mode. The resume-from session id
 * is deliberately NOT surfaced here (session-shaped; boundary rule).
 */
export function buildDaemonLaunchConfig(req: SpawnRequest, mode: DaemonMode): LaunchConfig {
  const config: LaunchConfig = {
    headless: false,
    agentHostType: 'daemon',
    daemonMode: mode,
    transport: 'claude-daemon',
  }
  if (req.model) config.model = req.model
  if (mode !== 'attach') {
    if (req.daemonSettingsPath) config.daemonSettingsPath = req.daemonSettingsPath
    if (req.daemonMcpConfigPath) config.daemonMcpConfigPath = req.daemonMcpConfigPath
    if (req.appendSystemPrompt) config.appendSystemPrompt = req.appendSystemPrompt
    if (req.env) config.env = req.env
  }
  return config
}

/** One-line summary of the config flags a NEW/RESUME spawn injects. */
function describeDaemonConfig(req: SpawnRequest): string {
  return (
    `${req.daemonSettingsPath ? ' +settings' : ''}` +
    `${req.daemonMcpConfigPath ? ' +mcp' : ''}` +
    `${req.appendSystemPrompt ? ' +sysprompt' : ''}` +
    `${req.env ? ` +${Object.keys(req.env).length}env` : ''}`
  )
}

async function spawnDaemon(rawReq: SpawnRequest, deps: SpawnDeps): Promise<SpawnResult> {
  // Transport reframe: collapse the new transportMeta shape onto the legacy flat
  // fields so the rest of this backend reads one normalized request.
  const req = normalizeDaemonReq(rawReq)
  const daemonMode: DaemonMode = req.daemonMode ?? 'new'

  const modeErr = validateDaemonModeFields(req, daemonMode)
  if (modeErr) return { ok: false, error: modeErr, statusCode: 400 }

  const sentinelResult = resolveSentinel(req, deps)
  if (!sentinelResult.ok) return sentinelResult.error
  const { sentinel, resolvedSentinelId } = sentinelResult

  if (resolvedSentinelId && !deps.conversationStore.isSentinelAlive(resolvedSentinelId)) {
    return { ok: false, error: 'Sentinel not responding (no heartbeat received recently)', statusCode: 503 }
  }

  const usedNames = new Set(
    deps.conversationStore
      .getAllConversations()
      .map(s => s.title)
      .filter(Boolean) as string[],
  )
  if (req.name) {
    const nameErr = validateConversationName(req.name, usedNames)
    if (nameErr) return { ok: false, error: nameErr, statusCode: 400 }
  }

  const requestId = randomUUID()
  const jobId = req.jobId ?? randomUUID()

  // ATTACH takes over an already-mirrored daemon roster conversation -- reuse
  // its conversationId. NEW/RESUME mint a fresh one. If the roster has not been
  // seen yet (no mirror row), ATTACH falls back to minting one too.
  const reused =
    daemonMode === 'attach' && req.daemonAttachShort
      ? findDaemonConversationByShort(deps, req.daemonAttachShort)
      : undefined
  const conversationId = reused?.id ?? randomUUID()
  const conversationName = deriveConversationName(req) ?? reused?.title ?? generateConversationName(usedNames)
  const project = reused?.project ?? cwdToProjectUri(req.cwd, 'daemon')

  console.log(
    `[daemon-spawn] dispatch mode=${daemonMode} conv=${conversationId.slice(0, 8)} job=${jobId.slice(0, 8)} ` +
      `sentinel=${req.sentinel ?? 'default'} reusedConv=${reused ? 'yes' : 'no'}` +
      (daemonMode === 'attach' ? ` short=${req.daemonAttachShort}` : '') +
      (daemonMode === 'resume' ? ` resumeFrom=${req.daemonResumeSessionId?.slice(0, 8)}` : '') +
      (daemonMode !== 'attach' ? describeDaemonConfig(req) : ''),
  )

  deps.conversationStore.createJob(jobId, conversationId)
  emitProgress(deps.conversationStore, jobId, 'job_created', 'done', { conversationId })

  const result = await dispatchToSentinel({
    sentinel,
    deps,
    req,
    requestId,
    conversationId,
    jobId,
    conversationName,
    daemonMode,
  })

  if (!result.success) {
    const errorMsg = result.error || 'Spawn failed'
    console.warn(`[daemon-spawn] FAILED mode=${daemonMode} conv=${conversationId.slice(0, 8)}: ${errorMsg}`)
    emitProgress(deps.conversationStore, jobId, 'failed', 'error', { error: errorMsg })
    deps.conversationStore.failJob(jobId, errorMsg)
    return { ok: false, error: errorMsg, statusCode: 500 }
  }

  // Pre-tag the conversation so boot/input messages route to this backend
  // before the daemon-agent-host's agent_host_boot arrives and fills the rest.
  let conv = deps.conversationStore.getConversation(conversationId)
  if (!conv) {
    conv = deps.conversationStore.createConversation(conversationId, project, req.model || '', [], ['terminal'])
  }
  const statusBefore = conv.status
  conv.agentHostType = 'daemon'
  conv.transport = 'claude-daemon'
  conv.agentHostMeta = buildDaemonLaunchMeta(req, daemonMode, conv.agentHostMeta)
  // The typed, control-panel-facing launch record (read-only Launch config
  // block). Separate from the opaque agentHostMeta revive bag above.
  conv.launchConfig = buildDaemonLaunchConfig(req, daemonMode)
  conv.project = project
  conv.title = req.name || conversationName
  if (req.description) conv.description = req.description
  // ATTACH reactivates a previously read-only / ended roster mirror row.
  if (conv.status === 'ended') conv.endedBy = undefined
  deps.conversationStore.persistConversationById(conversationId)

  console.log(
    `[daemon-spawn] OK mode=${daemonMode} conv=${conversationId.slice(0, 8)} ` +
      `statusBefore=${statusBefore} tmux=${result.tmuxSession ?? 'none'} launchConfig=persisted`,
  )
  emitProgress(deps.conversationStore, jobId, 'agent_acked', 'done')
  return { ok: true, conversationId, jobId, tmuxSession: result.tmuxSession }
}

/** Resolve the target sentinel for this spawn (explicit alias or the default). */
function resolveSentinel(
  req: SpawnRequest,
  deps: SpawnDeps,
):
  | { ok: true; sentinel: NonNullable<ReturnType<ConversationStore['getSentinel']>>; resolvedSentinelId?: string }
  | { ok: false; error: SpawnResult } {
  if (req.sentinel) {
    const sentinel = deps.conversationStore.getSentinelByAlias(req.sentinel)
    if (!sentinel) {
      const available = deps.conversationStore
        .getConnectedSentinels()
        .map(s => s.alias)
        .join(', ')
      return {
        ok: false,
        error: {
          ok: false,
          error: `Sentinel "${req.sentinel}" is offline. Available: ${available || 'none'}`,
          statusCode: 503,
        },
      }
    }
    const resolvedSentinelId = deps.conversationStore
      .getConnectedSentinels()
      .find(s => s.alias === req.sentinel)?.sentinelId
    return { ok: true, sentinel, resolvedSentinelId }
  }
  const sentinel = deps.conversationStore.getSentinel()
  if (!sentinel) return { ok: false, error: { ok: false, error: 'No sentinel connected', statusCode: 503 } }
  return { ok: true, sentinel, resolvedSentinelId: deps.conversationStore.getDefaultSentinelId() }
}

/**
 * Build the `spawn` payload sent to the sentinel. NEW/RESUME carry the prompt
 * and config injection; ATTACH carries only the roster short (no claude --bg,
 * no config -- the worker is already configured).
 */
export function buildSentinelSpawnMessage(opts: {
  req: SpawnRequest
  requestId: string
  conversationId: string
  jobId: string
  conversationName: string
  daemonMode: DaemonMode
}): Record<string, unknown> {
  const { req, requestId, conversationId, jobId, conversationName, daemonMode } = opts
  const msg: Record<string, unknown> = {
    type: 'spawn',
    requestId,
    conversationId,
    jobId,
    // The sentinel routes daemon-tagged spawns to its daemon dispatch path.
    agentHostType: 'daemon',
    daemonMode,
    // Transport reframe: forward the discriminator + opaque bag wholesale so
    // they round-trip to the sentinel. The sentinel still routes by
    // `agentHostType` in Phase 1; it branches on `transport` from Phase 2.
    transport: req.transport,
    transportMeta: req.transportMeta,
    cwd: req.cwd,
    mkdir: req.mkdir || false,
    mode: req.mode || 'fresh',
    model: req.model || undefined,
    conversationName,
    conversationDescription: req.description || undefined,
    env: req.env || undefined,
  }
  if (daemonMode === 'attach') {
    msg.daemonAttachShort = req.daemonAttachShort
    return msg
  }
  // NEW / RESUME -- prompt + config injection.
  msg.prompt = req.prompt
  if (daemonMode === 'resume') msg.daemonResumeSessionId = req.daemonResumeSessionId
  if (req.daemonSettingsPath) msg.daemonSettingsPath = req.daemonSettingsPath
  if (req.daemonMcpConfigPath) msg.daemonMcpConfigPath = req.daemonMcpConfigPath
  if (req.appendSystemPrompt) msg.appendSystemPrompt = req.appendSystemPrompt
  return msg
}

/** Send the spawn message to the sentinel and await its spawn_result. */
function dispatchToSentinel(opts: {
  sentinel: NonNullable<ReturnType<ConversationStore['getSentinel']>>
  deps: SpawnDeps
  req: SpawnRequest
  requestId: string
  conversationId: string
  jobId: string
  conversationName: string
  daemonMode: DaemonMode
}): Promise<SentinelSpawnResult> {
  const { sentinel, deps, req, requestId, conversationId, jobId, daemonMode } = opts
  return new Promise<SentinelSpawnResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      deps.conversationStore.removeSpawnListener(requestId)
      reject(new Error('Sentinel did not respond (15s timeout)'))
    }, 15000)

    deps.conversationStore.addSpawnListener(requestId, msg => {
      clearTimeout(timeout)
      resolve(msg as SentinelSpawnResult)
    })

    emitProgress(deps.conversationStore, jobId, 'spawn_sent', 'active')
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

    try {
      sentinel.send(JSON.stringify(buildSentinelSpawnMessage(opts)))
      console.log(
        `[daemon-spawn] spawn message sent to sentinel mode=${daemonMode} conv=${conversationId.slice(0, 8)} ` +
          `req=${requestId.slice(0, 8)}`,
      )
    } catch {
      clearTimeout(timeout)
      deps.conversationStore.removeSpawnListener(requestId)
      reject(new Error('Sentinel offline (send failed)'))
    }
  }).catch(
    (err: unknown): SentinelSpawnResult => ({
      type: 'spawn_result',
      requestId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  )
}
