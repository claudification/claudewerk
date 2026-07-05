#!/usr/bin/env bun
/**
 * sentinel - Host-side sentinel for conversation revival and spawning
 *
 * Connects to broker via WebSocket, listens for revive/spawn commands.
 * Headless conversations are spawned directly via Bun.spawn() with PID tracking.
 * PTY/interactive conversations still use tmux via revive-session.sh.
 *
 * Only one sentinel can be connected at a time. If another agent is already
 * connected, this process exits immediately.
 */

import { checkBunVersion } from '../shared/bun-version'

checkBunVersion()

import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Subprocess } from 'bun'
import { dispatch, has, ping } from '../shared/cc-daemon/ops'
import { resolveControlSocket } from '../shared/cc-daemon/socket-path'
import type { DispatchSpec } from '../shared/cc-daemon/types'
import { claudeConfigDir } from '../shared/claude-config-dir'
import { DAEMON_MCP_ENDPOINT_ENV } from '../shared/daemon-mcp-endpoint'
import { cwdToProjectUri, parseProjectUri } from '../shared/project-uri'
import type {
  BrokerSentinelMessage,
  CcVersionChanged,
  FetchArtifact,
  GitFabricRequest,
  GitFabricResult,
  GitLogRequest,
  GitLogResult,
  ListCcSessionsResult,
  ListDirsResult,
  NightshiftOp,
  ProfileUsageSnapshot,
  ProjectBoardOp,
  ProjectMoveFile,
  ProjectReadFile,
  ProjectUnwatch,
  ProjectWatch,
  ProjectWriteFile,
  QuestOp,
  ReviveConversation,
  ReviveResult,
  SentinelIdentify,
  SentinelPatchConfig,
  SentinelPatchConfigAck,
  ShellActivity,
  ShellClose,
  ShellExit,
  ShellOpen,
  ShellOriginated,
  ShellResync,
  SpawnConversation,
  SpawnFailed,
  SpawnResult,
} from '../shared/protocol'
import { DEFAULT_BROKER_URL, HEARTBEAT_INTERVAL_MS } from '../shared/protocol'
import { secureTmpPath, writeSecureFile } from '../shared/secure-temp'
import { getAcpRecipe, listAcpRecipes } from './acp-recipes'
import { BUILTIN_ARTIFACT_PATTERNS, handleFetchArtifact } from './artifact-handlers'
import { type CcVersionWatcher, createCcVersionWatcher, type LastSeenCcVersion } from './cc-version-watcher'
import {
  applyPatchInPlace,
  atomicWriteRawConfig,
  readRawConfigObject,
  spliceRawConfig,
  validatePatch,
} from './config-patch'
import { handleControlRequest, resolveControlSocketPath, runShellCli, startControlSocketServer } from './control-socket'
import {
  buildDispatchSpec,
  type DaemonLaunchMode,
  evaluateAttachPresence,
  validateDaemonConfigPaths,
} from './daemon-dispatch'
import { writeDaemonMcpConfig } from './daemon-mcp-config'
import { registerDaemonSession, startDaemonRosterWatch, stopDaemonRosterWatch } from './daemon-roster'
import { expandPath } from './expand-path'
import { runGitFabric } from './git-fabric'
import { runGitLog } from './git-log'
import { handleNightshiftOp } from './nightshift-handlers'
import { applyOAuthToken, applyOAuthTokenDelta } from './oauth-token-env'
import { type PreflightIssue, preflightSpawn } from './preflight'
import { runProfileCli } from './profile-cli'
import {
  handleProjectBoardOp,
  handleProjectMoveFile,
  handleProjectReadFile,
  handleProjectWriteFile,
} from './project-handlers'
import { stopAllWatches, unwatchProject, watchProject } from './project-watch'
import { ptyCrossBoundaryEnvKeys, shouldInjectConfigDir } from './pty-env'
import { handleQuestOp } from './quest-handlers'
import { pickProfile, type UsageHeadroom } from './selection'
import {
  configDirFor,
  DEFAULT_PROFILE_NAME,
  defaultConfigPath,
  getPools,
  loadSentinelConfig,
  profileNameForConfigDir,
  profileSummaries,
  type ResolvedProfile,
  resolveProfile,
  type SentinelConfig,
} from './sentinel-config'
import { ShellDataWs } from './shell-data-ws'
import { ACTIVITY_COALESCE_MS, ShellRegistry } from './shell-pty'
import { headlessNdjsonPath, parseHookStage, RingBuffer, tailHeadlessNdjson } from './spawn-error'
import { buildCarriedSnapshot, defaultUsageCachePath, loadUsageCache, saveUsageCache } from './usage-cache'
import { snapshotHasWindows } from './usage-headroom'
import { resolveBalancedHeadrooms } from './usage-lean'
import { buildSentinelUsageReport, pollProfileUsage, snapshotToLegacyUsageUpdate } from './usage-poller'

/** Pre-flight warnings stashed per-conversation. Surfaced when CC dies early
 *  after spawn so the user sees a likely cause instead of a bare exit code. */
const preflightWarnings = new Map<string, string[]>()

/**
 * Run pre-flight + emit launch_log entries + stash warnings. Returns whether
 * the spawn should proceed. Hard failures emit `error` and return false; soft
 * warnings emit `warn`, stash, and return true.
 */
function runPreflight(opts: {
  cwd: string
  worktree?: string
  resumeCcSessionId?: string
  conversationId: string
  jobId?: string
  /** Active sentinel-profile configDir. Routed into preflight's transcript
   *  slug check so resume looks in the right profile's projects dir. */
  configDir?: string
}): boolean {
  const { issues, ok } = preflightSpawn({
    cwd: opts.cwd,
    worktree: opts.worktree,
    resumeCcSessionId: opts.resumeCcSessionId,
    configDir: opts.configDir,
  })
  const warnings: string[] = []
  for (const issue of issues) {
    if (issue.severity === 'fail') {
      launchLog(opts.jobId, `Pre-flight: ${issue.check}`, 'error', issue.message)
      diag('preflight', `FAIL ${issue.check}`, { ...issue.detail, conversationId: opts.conversationId })
    } else {
      launchLog(opts.jobId, `Pre-flight: ${issue.check}`, 'warn', issue.message)
      diag('preflight', `WARN ${issue.check}`, { ...issue.detail, conversationId: opts.conversationId })
      warnings.push(issue.message)
    }
  }
  if (warnings.length > 0) {
    preflightWarnings.set(opts.conversationId, warnings)
  }
  return ok
}

/** Look up + clear stashed pre-flight warnings for a conversation. */
function consumePreflightWarnings(conversationId: string): string[] | undefined {
  const w = preflightWarnings.get(conversationId)
  if (!w) return undefined
  preflightWarnings.delete(conversationId)
  return w
}

// Re-export for type-checking on the issue shape.
export type { PreflightIssue }

function getRawMachineId(): string {
  const platform = process.platform

  if (platform === 'darwin') {
    try {
      const result = Bun.spawnSync(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (result.success) {
        const output = result.stdout.toString()
        const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
        if (match) return match[1]
      }
    } catch {}
  }

  if (platform === 'linux') {
    try {
      const id = readFileSync('/etc/machine-id', 'utf8').trim()
      if (id) return id
    } catch {}
  }

  return osHostname()
}

function getMachineId(): string {
  const raw = getRawMachineId()
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

const RECONNECT_DELAY_MS = 5000

// ─── tmux binary discovery ────────────────────────────────────────────
// When the sentinel runs as a launchd daemon (macOS), it inherits a minimal PATH
// (e.g. /usr/bin:/bin:/usr/sbin:/sbin) without Homebrew's /opt/homebrew/bin.
// Resolve tmux to an absolute path at startup by checking common package manager
// locations directly, without mutating process.env.PATH (which would widen the
// PATH inherited by all child processes).
function findTmuxBinary(): string {
  // First, check the existing PATH
  const fromPath = Bun.which('tmux')
  if (fromPath) return fromPath
  // Check common package manager locations that may not be in PATH
  const extraDirs = [
    '/opt/homebrew/bin', // Homebrew on Apple Silicon
    '/usr/local/bin', // Homebrew on Intel Mac / common Linux
    '/home/linuxbrew/.linuxbrew/bin', // Homebrew on Linux (system-wide)
    join(process.env.HOME || '/root', '.linuxbrew', 'bin'), // Homebrew on Linux (per-user)
  ]
  for (const dir of extraDirs) {
    const candidate = join(dir, 'tmux')
    if (existsSync(candidate)) return candidate
  }
  return 'tmux' // bare fallback — will fail with a clear error at the call site
}

const TMUX_BIN = findTmuxBinary()

// ─── PID Registry (headless child process tracking) ─────────────────
const PID_REGISTRY_DIR = join(process.env.HOME || '/root', '.rclaude')
const PID_REGISTRY_PATH = join(PID_REGISTRY_DIR, 'sentinel-sessions.json')
const SENTINEL_SETTINGS_PATH = join(PID_REGISTRY_DIR, 'sentinel-settings.json')

/** Read the persisted last-seen CC version/proto pair. Tolerant of a missing
 *  or malformed file -- treats both as the first-observation case (null/null). */
function loadCcVersionState(): LastSeenCcVersion {
  try {
    if (!existsSync(SENTINEL_SETTINGS_PATH)) return { version: null, proto: null }
    const raw = JSON.parse(readFileSync(SENTINEL_SETTINGS_PATH, 'utf8')) as Record<string, unknown>
    const version = typeof raw.lastSeenCcVersion === 'string' ? raw.lastSeenCcVersion : null
    const proto = typeof raw.lastSeenCcProto === 'number' ? raw.lastSeenCcProto : null
    return { version, proto }
  } catch {
    return { version: null, proto: null }
  }
}

/** Persist the latest CC version/proto pair. Merges into any existing settings. */
function saveCcVersionState(next: LastSeenCcVersion): void {
  try {
    mkdirSync(PID_REGISTRY_DIR, { recursive: true })
    let current: Record<string, unknown> = {}
    if (existsSync(SENTINEL_SETTINGS_PATH)) {
      try {
        current = JSON.parse(readFileSync(SENTINEL_SETTINGS_PATH, 'utf8')) as Record<string, unknown>
      } catch {
        current = {}
      }
    }
    current.lastSeenCcVersion = next.version
    current.lastSeenCcProto = next.proto
    writeFileSync(SENTINEL_SETTINGS_PATH, JSON.stringify(current, null, 2))
  } catch (e) {
    log(`Failed to persist sentinel-settings.json: ${e}`)
  }
}

interface PidRegistryEntry {
  conversationId: string
  pid: number
  cwd: string
  startedAt: string
}

interface TrackedChild {
  proc: Subprocess
  conversationId: string
  pid: number
  cwd: string
  startedAt: string
  /** Last ~30 lines of the host's stderr; used to enrich SpawnFailed.error
   *  when the child exits abnormally. See src/sentinel/spawn-error.ts. */
  stderrRing: RingBuffer<string>
}

/** Live headless children spawned by this sentinel instance */
const trackedChildren = new Map<string, TrackedChild>()

/**
 * Per-profile live-load tracker (sentinel-side). Maps profile NAME -> count
 * of live agent hosts running under that profile. Fed by `bindConversationToProfile`
 * at successful spawn / revive dispatch and decremented when the conversation's
 * trackedChild is removed. Consumed by Balanced selection (see selection.ts).
 *
 * Kept separate from `trackedChildren` because not every spawn path produces
 * a trackedChild here (daemon-host attaches to an out-of-process worker), and
 * because the picker needs the profile dimension which TrackedChild doesn't
 * carry.
 */
const profileLoad = new Map<string, number>()
const conversationProfileBinding = new Map<string, string>()

function bindConversationToProfile(conversationId: string, profileName: string): void {
  // Drop any prior binding -- a re-spawn under a different profile would otherwise leak.
  unbindConversationFromProfile(conversationId)
  conversationProfileBinding.set(conversationId, profileName)
  profileLoad.set(profileName, (profileLoad.get(profileName) ?? 0) + 1)
}

function unbindConversationFromProfile(conversationId: string): void {
  const name = conversationProfileBinding.get(conversationId)
  if (!name) return
  conversationProfileBinding.delete(conversationId)
  const cur = profileLoad.get(name) ?? 0
  if (cur <= 1) profileLoad.delete(name)
  else profileLoad.set(name, cur - 1)
}

/** Returns live load count for a profile (0 if absent). For Balanced selection. */
function liveLoadForProfile(profileName: string): number {
  return profileLoad.get(profileName) ?? 0
}

/** Smart Balance treats a snapshot older than this as stale and falls back
 *  to live-host count. Poll interval is 3min, so 3.3 missed cycles = stale. */
const USAGE_STALE_MS = 10 * 60 * 1000

/** Carry-forward window for a profile whose latest usage poll failed with a 401
 *  (expired/revoked token). Far longer than the 429 backoff: an idle profile's
 *  token only refreshes when CC runs under it, so it needs a ranking foothold
 *  long enough to win a spawn and re-auth. 6h comfortably spans a couple of 5h
 *  window resets (post-reset decay then lets it climb back into the eligible
 *  band); past 6h with no successful poll it falls to UNKNOWN (load-based), so a
 *  permanently-dead profile stops attracting traffic rather than pinning forever. */
const AUTH_ERROR_CARRY_FORWARD_MS = 6 * 60 * 60 * 1000

/** Build the `pickProfile` headroom source for the WHOLE pool in one pass,
 *  applying the unmeasurable-profile lean: a probe-unmeasurable BUT credentialed
 *  profile (401/429 -- expired idle token or a rate-limited shared usage meter)
 *  is treated OPTIMISTICALLY (assumed recently reset) instead of collapsing into
 *  the UNKNOWN band and losing every balanced spawn. This breaks the starvation
 *  deadlock for the shared default login: its inference works without the usage
 *  scope, so leaning toward it is safe AND is the best way to wake its token (a
 *  spawn refreshes it; the next successful poll then takes over). Per-profile
 *  carry-forward of the last error-free reading still applies first. See
 *  `resolveBalancedHeadrooms` in `usage-lean.ts`.
 *
 *  Returns the resolved source plus the names that were SUBSTITUTED, for the
 *  LOG-EVERYTHING covenant (the picker log surfaces the lean decisions). */
function buildPickerUsageSource(config: SentinelConfig): {
  usage: (name: string) => UsageHeadroom | undefined
  substituted: string[]
} {
  const latest = getLatestProfileUsage()
  const lastGood = getLastGoodProfileUsage()
  const entries = Object.keys(config.profiles).map(name => ({
    name,
    latest: latest.get(name),
    lastGood: lastGood.get(name),
  }))
  const resolved = resolveBalancedHeadrooms(entries, Date.now(), {
    staleMs: USAGE_STALE_MS,
    carryForwardStaleMs: RATE_LIMIT_MAX_BACKOFF_MS,
    authErrorCarryForwardMs: AUTH_ERROR_CARRY_FORWARD_MS,
  })
  const substituted = [...resolved.entries()].filter(([, r]) => r.substituted).map(([name]) => name)
  return { usage: name => resolved.get(name)?.headroom, substituted }
}

/** Dead PIDs discovered from registry on startup (reported once WS connects) */
const deadPidsToReport: PidRegistryEntry[] = []

function writePidRegistry() {
  const entries: PidRegistryEntry[] = [...trackedChildren.values()].map(c => ({
    conversationId: c.conversationId,
    pid: c.pid,
    cwd: c.cwd,
    startedAt: c.startedAt,
  }))
  try {
    mkdirSync(PID_REGISTRY_DIR, { recursive: true })
    writeFileSync(PID_REGISTRY_PATH, JSON.stringify(entries, null, 2))
  } catch (e) {
    log(`Failed to write PID registry: ${e}`)
  }
}

function loadAndCheckPidRegistry() {
  if (!existsSync(PID_REGISTRY_PATH)) return
  try {
    const entries: PidRegistryEntry[] = JSON.parse(readFileSync(PID_REGISTRY_PATH, 'utf8'))
    for (const entry of entries) {
      try {
        process.kill(entry.pid, 0) // check if alive (signal 0 = no-op)
        log(`PID ${entry.pid} still alive (wrapper ${entry.conversationId.slice(0, 8)}, cwd=${entry.cwd})`)
        // Can't re-attach Bun.spawn to existing PID - just note it's alive.
        // The rclaude process manages its own WS connection to the broker.
      } catch {
        log(`PID ${entry.pid} dead (wrapper ${entry.conversationId.slice(0, 8)})`)
        deadPidsToReport.push(entry)
      }
    }
    unlinkSync(PID_REGISTRY_PATH)
  } catch (e) {
    log(`Failed to read PID registry: ${e}`)
  }
}

/** Report dead PIDs from a previous sentinel run (called after WS connects) */
function reportDeadPids(ws: WebSocket) {
  for (const entry of deadPidsToReport) {
    const msg: SpawnFailed = {
      type: 'spawn_failed',
      conversationId: entry.conversationId,
      project: cwdToProjectUri(entry.cwd),
      pid: entry.pid,
      error: 'Process died during sentinel restart (discovered from PID registry)',
    }
    try {
      ws.send(JSON.stringify(msg))
    } catch {}
  }
  if (deadPidsToReport.length > 0) {
    log(`Reported ${deadPidsToReport.length} dead PIDs from previous run`)
  }
  deadPidsToReport.length = 0
}

// ─── CC Transcript Discovery ─────────────────────────────────────────

function listCcSessions(cwd: string, configDir: string): ListCcSessionsResult['ccSessions'] {
  const mangledCwd = cwd.replace(/\//g, '-')
  const projectDir = join(configDir, 'projects', mangledCwd)
  if (!existsSync(projectDir)) return []

  const entries: ListCcSessionsResult['ccSessions'] = []
  for (const file of readdirSync(projectDir)) {
    if (!file.endsWith('.jsonl')) continue
    const ccSessionId = file.slice(0, -6)
    const filePath = join(projectDir, file)
    try {
      const stat = statSync(filePath)
      let title: string | undefined
      const proc = Bun.spawnSync(['head', '-1', filePath])
      const firstLine = proc.stdout.toString().trim()
      if (firstLine) {
        try {
          const first = JSON.parse(firstLine)
          title = first.customTitle || first.agentName || undefined
        } catch {
          /* malformed first line */
        }
      }
      entries.push({ ccSessionId, title, mtime: stat.mtimeMs, sizeBytes: stat.size })
    } catch {
      /* stat/read error, skip */
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  return entries.slice(0, 50)
}

// ─── rclaude Binary Discovery ────────────────────────────────────────

function findRclaudeBinary(): string | null {
  // Bun.which checks PATH
  const fromPath = Bun.which('rclaude')
  if (fromPath) return fromPath
  // Fallback: same dir as sentinel binary, or ~/.local/bin
  const binDir = dirname(resolve(process.argv[0]))
  const homeLocalBin = join(process.env.HOME || '/root', '.local', 'bin')
  const candidates = [resolve(binDir, 'rclaude'), resolve(homeLocalBin, 'rclaude')]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

/**
 * Locate the opencode-host binary. Same lookup strategy as rclaude:
 * PATH first, then sentinel's bin dir, then ~/.local/bin. Returns null
 * if not found -- the sentinel rejects opencode spawns with a helpful
 * error in that case.
 */
function findOpenCodeHostBinary(): string | null {
  const fromPath = Bun.which('opencode-host')
  if (fromPath) return fromPath
  const binDir = dirname(resolve(process.argv[0]))
  const homeLocalBin = join(process.env.HOME || '/root', '.local', 'bin')
  const candidates = [resolve(binDir, 'opencode-host'), resolve(homeLocalBin, 'opencode-host')]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

/** Locate the acp-host binary. Same strategy as opencode-host. */
function findAcpHostBinary(): string | null {
  const fromPath = Bun.which('acp-host')
  if (fromPath) return fromPath
  const binDir = dirname(resolve(process.argv[0]))
  const homeLocalBin = join(process.env.HOME || '/root', '.local', 'bin')
  const candidates = [resolve(binDir, 'acp-host'), resolve(homeLocalBin, 'acp-host')]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

/** Locate the daemon-host binary (attaches to a Claude Code daemon worker).
 *  Same lookup strategy as opencode-host / acp-host. */
function findDaemonHostBinary(): string | null {
  const fromPath = Bun.which('daemon-host')
  if (fromPath) return fromPath
  const binDir = dirname(resolve(process.argv[0]))
  const homeLocalBin = join(process.env.HOME || '/root', '.local', 'bin')
  const candidates = [resolve(binDir, 'daemon-host'), resolve(homeLocalBin, 'daemon-host')]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

// ─── Env Sanitization ──────────────────────────────────────────────

/** Conversation-scoped RCLAUDE_* vars that must NOT leak from the sentinel's own
 *  environment into spawned child conversations. The sentinel may have inherited
 *  these from the rclaude process that launched it. Each spawned conversation
 *  gets its own values set explicitly. */
const RCLAUDE_CONVERSATION_VARS = new Set([
  'RCLAUDE_HEADLESS',
  'RCLAUDE_CONVERSATION_ID',
  'CLAUDWERK_CONVERSATION_NAME',
  'CLAUDWERK_CONVERSATION_DESCRIPTION',
  'RCLAUDE_SECRET',
  'RCLAUDE_PERMISSION_MODE',
  'RCLAUDE_BARE',
  'RCLAUDE_ADHOC',
  'RCLAUDE_ADHOC_TASK_ID',
  'RCLAUDE_CHANNELS',
  'RCLAUDE_INITIAL_PROMPT_FILE',
  'RCLAUDE_WORKTREE',
  'RCLAUDE_EFFORT',
  'RCLAUDE_MODEL',
  'RCLAUDE_AUTOCOMPACT_PCT',
  'RCLAUDE_MAX_BUDGET_USD',
  'RCLAUDE_PORT',
  'RCLAUDE_CUSTOM_ENV',
  'RCLAUDE_INCLUDE_PARTIAL_MESSAGES',
  'CLAUDWERK_APPEND_SYSTEM_PROMPT',
  'CLAUDWERK_APPEND_SYSTEM_PROMPT_FILE',
  'CLAUDWERK_SETTINGS_PATH',
  'CLAUDWERK_MCP_CONFIG_PATH',
  DAEMON_MCP_ENDPOINT_ENV,
])

/**
 * Return a copy of process.env with conversation-scoped RCLAUDE_* and
 * CLAUDE_CODE_* vars stripped. Safe base for building child env.
 */
function cleanSentinelEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || RCLAUDE_CONVERSATION_VARS.has(key)) {
      delete env[key]
    }
  }
  return env
}

/**
 * Env to feed `resolveControlSocket` / `resolveSockDir` so the right
 * profile's daemon roster (~/.claude vs ~/.claude-work) is consulted.
 * Always returns a concrete env -- an explicit env arg also engages strict
 * mode in the resolver (no scan fallback, which can't disambiguate between
 * profile-isolated daemons under `/tmp/cc-daemon-<uid>/`). Default profile
 * gets `{}`, which `rosterPath()` resolves to `~/.claude/daemon/roster.json`.
 *
 * NOTE: when the resolved profile's daemon is up but has 0 workers yet,
 * roster.json carries `supervisorPid` but no socket hints, so the strict
 * resolver returns null. That edge case fails clean ("no socket reachable
 * for profile=X") rather than silently routing to another profile's daemon.
 */
function socketEnvForProfile(profile?: ResolvedProfile): NodeJS.ProcessEnv {
  const configDir = profile?.configDir
  return shouldInjectConfigDir(configDir) ? { CLAUDE_CONFIG_DIR: configDir } : {}
}

// ─── Direct Headless Spawn ──────────────────────────────────────────

/**
 * Build the env object for a directly-spawned headless rclaude process.
 * Replicates what revive-session.sh sets up, minus the shell quoting dance.
 *
 * Sentinel-profile injection (see `.claude/docs/plan-sentinel-profiles.md`):
 * `configDir` sets `CLAUDE_CONFIG_DIR` on the spawned agent-host process AND
 * the `claude` CLI child it forks -- both need it (the agent-host's hooks +
 * transcript-path discovery, the CLI's own config/credential discovery).
 * `profileEnv` is merged in alongside (e.g. `ANTHROPIC_API_KEY` for an alt
 * account). Both are REAL env vars, not stuffed into `RCLAUDE_CUSTOM_ENV` --
 * the agent-host process must see them in its own `process.env`.
 *
 * `RCLAUDE_CUSTOM_ENV` (the existing `opts.env`) carries USER-typed env from
 * the launch config; it's kept separate from `profileEnv` so the user env
 * (broker-persisted, audit-visible) is not entangled with the profile env
 * (sentinel-resident, never persisted -- Profile-Env Boundary covenant).
 */
function buildHeadlessEnv(opts: {
  secret: string
  conversationId: string
  ccSessionId?: string
  conversationName?: string
  conversationDescription?: string
  permissionMode?: string
  autocompactPct?: number
  maxBudgetUsd?: number
  agent?: string
  adHoc?: boolean
  adHocTaskId?: string
  leaveRunning?: boolean
  promptFile?: string
  worktree?: string
  effort?: string
  model?: string
  /** Advisor model (CC 2.1.170 server-side advisor tool). Presence enables it. */
  advisor?: string
  bare?: boolean
  repl?: boolean
  includePartialMessages?: boolean
  appendSystemPrompt?: string
  /** Backend-general `--settings` path (transport-reframe Phase 2). The agent
   *  host MERGES it into its generated hooks settings file. */
  settingsPath?: string
  /** Backend-general `--mcp-config` path (transport-reframe Phase 2). The agent
   *  host appends it as an extra `--mcp-config` value. */
  mcpConfigPath?: string
  env?: Record<string, string>
  /** Resolved configDir for the active sentinel profile. Injected as
   *  `CLAUDE_CONFIG_DIR` on the child process. */
  configDir?: string
  /** Resolved profile env (e.g. `ANTHROPIC_API_KEY`). Merged DIRECTLY into
   *  process env so the agent host and its `claude` child both see it. */
  profileEnv?: Record<string, string>
  /** Resolved long-lived OAuth token for the active profile. Injected as
   *  `CLAUDE_CODE_OAUTH_TOKEN`; conflicting host `ANTHROPIC_*` creds are
   *  stripped so the token actually wins (auth precedence #3 > #5). */
  oauthToken?: string
}): Record<string, string | undefined> {
  // Start from sanitized sentinel env (PATH, API keys, etc. but no conversation-scoped vars)
  const env = cleanSentinelEnv()

  // Required
  env.RCLAUDE_SECRET = opts.secret
  env.RCLAUDE_CONVERSATION_ID = opts.conversationId
  env.RCLAUDE_HEADLESS = '1'

  // Optional
  if (opts.ccSessionId) env.RCLAUDE_CC_SESSION_ID = opts.ccSessionId
  if (opts.conversationName) env.CLAUDWERK_CONVERSATION_NAME = opts.conversationName
  if (opts.conversationDescription) env.CLAUDWERK_CONVERSATION_DESCRIPTION = opts.conversationDescription
  if (opts.permissionMode) env.RCLAUDE_PERMISSION_MODE = opts.permissionMode
  if (opts.autocompactPct) env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(opts.autocompactPct)
  if (opts.bare) env.RCLAUDE_BARE = '1'
  if (opts.repl) env.CLAUDE_CODE_REPL = 'true'
  if (opts.adHoc) {
    env.RCLAUDE_ADHOC = '1'
    env.RCLAUDE_CHANNELS = '0'
  }
  if (opts.adHocTaskId) env.RCLAUDE_ADHOC_TASK_ID = opts.adHocTaskId
  if (opts.leaveRunning) env.RCLAUDE_LEAVE_RUNNING = '1'
  if (opts.promptFile) env.RCLAUDE_INITIAL_PROMPT_FILE = opts.promptFile
  if (opts.worktree) env.RCLAUDE_WORKTREE = opts.worktree
  if (opts.agent) env.RCLAUDE_AGENT = opts.agent
  if (opts.advisor) {
    // cli-args turns RCLAUDE_ADVISOR into `--advisor <model>`; the experimental
    // gate must be a real env on the child for CC to expose the advisor tool.
    env.RCLAUDE_ADVISOR = opts.advisor
    env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL = '1'
  }
  if (opts.includePartialMessages === false) env.RCLAUDE_INCLUDE_PARTIAL_MESSAGES = '0'
  if (opts.appendSystemPrompt) env.CLAUDWERK_APPEND_SYSTEM_PROMPT = opts.appendSystemPrompt
  if (opts.settingsPath) env.CLAUDWERK_SETTINGS_PATH = opts.settingsPath
  if (opts.mcpConfigPath) env.CLAUDWERK_MCP_CONFIG_PATH = opts.mcpConfigPath
  if (opts.env && Object.keys(opts.env).length) env.RCLAUDE_CUSTOM_ENV = JSON.stringify(opts.env)

  // Sentinel profile -- inject CLAUDE_CONFIG_DIR + profile.env DIRECTLY into
  // the child process env (not via RCLAUDE_CUSTOM_ENV). The agent host AND
  // the `claude` CLI it forks both need these in `process.env`.
  // For the implicit default profile (~/.claude), omit CLAUDE_CONFIG_DIR so
  // CC falls through to its macOS Keychain credential lookup -- see
  // `shouldInjectConfigDir` above.
  if (shouldInjectConfigDir(opts.configDir)) env.CLAUDE_CONFIG_DIR = opts.configDir
  if (opts.profileEnv) {
    for (const [k, v] of Object.entries(opts.profileEnv)) env[k] = v
  }

  // Long-lived OAuth token -- applied LAST so the dedicated config field beats
  // any stray CLAUDE_CODE_OAUTH_TOKEN in profile.env. Strips the higher-priority
  // ANTHROPIC_* creds the sentinel may carry (precedence #3 > #5) unless
  // profile.env set them. See `oauth-token-env.ts`.
  applyOAuthToken(env, opts.oauthToken, opts.profileEnv)

  return env
}

/**
 * Build CLI args for a directly-spawned headless rclaude process.
 */
function buildHeadlessArgs(opts: {
  mode?: 'fresh' | 'resume'
  resumeId?: string
  resumeName?: string
  effort?: string
  model?: string
  agent?: string
  worktree?: string
  maxBudgetUsd?: number
  permissionMode?: string
}): string[] {
  // Headless has no human to answer a prompt, so the legacy default is full
  // bypass (--dangerously-skip-permissions) -- a spawn must never hang waiting
  // for an approval nobody can give. The two unattended-but-GUARDED modes
  // (auto = managed classifier, dontAsk = allow-list + read-only bash) are the
  // nightshift permission model (plan-nightshift.md §10): for those we must NOT
  // force bypass -- the chosen mode flows through RCLAUDE_PERMISSION_MODE ->
  // cli-args `--permission-mode`, and the deny-floor still bites. Every other
  // value (incl. undefined / plan / acceptEdits / bypassPermissions) keeps the
  // legacy bypass so no existing spawn changes behavior.
  const unattendedGuarded = opts.permissionMode === 'auto' || opts.permissionMode === 'dontAsk'
  const args: string[] = unattendedGuarded ? [] : ['--dangerously-skip-permissions']
  if (opts.mode === 'resume') {
    const resumeKey = opts.resumeId || opts.resumeName
    if (resumeKey) args.push('--resume', resumeKey)
  }
  if (opts.effort) args.push('--effort', opts.effort)
  if (opts.model) args.push('--model', opts.model)
  if (opts.agent) args.push('--agent', opts.agent)
  if (opts.worktree) args.push('--worktree', opts.worktree)
  if (opts.maxBudgetUsd) args.push('--max-budget-usd', String(opts.maxBudgetUsd))
  return args
}

/**
 * Spawn a headless rclaude conversation directly via Bun.spawn().
 * Returns immediately after process starts. Monitors exit asynchronously.
 */
function spawnHeadlessDirect(
  rclaudeBin: string,
  cwd: string,
  conversationId: string,
  args: string[],
  env: Record<string, string | undefined>,
  jobId?: string,
  isResume = false,
): { success: boolean; error?: string; pid?: number } {
  const startTime = Date.now()

  launchLog(jobId, 'Spawning headless (direct)', 'info', `${rclaudeBin} ${args.join(' ')}`)

  let proc: Subprocess
  try {
    proc = Bun.spawn([rclaudeBin, ...args], {
      cwd,
      env,
      stdout: 'ignore', // headless rclaude communicates via WS, not stdout
      stderr: 'pipe', // capture for diagnostics
    })
  } catch (e: unknown) {
    const err = `Bun.spawn failed: ${(e as Error).message}`
    launchLog(jobId, 'Spawn failed', 'error', err)
    return { success: false, error: err }
  }

  const pid = proc.pid
  log(`Headless spawn: PID ${pid} conv=${conversationId.slice(0, 8)} cwd=${cwd}`)

  // Track the child
  const child: TrackedChild = {
    proc,
    conversationId,
    pid,
    cwd,
    startedAt: new Date().toISOString(),
    stderrRing: new RingBuffer<string>(30),
  }
  trackedChildren.set(conversationId, child)
  writePidRegistry()

  // Capture stderr for diagnostics
  captureChildStderr(proc, conversationId)

  // Monitor for exit
  proc.exited.then(exitCode => {
    const elapsedMs = Date.now() - startTime
    // Snapshot the stderr ring BEFORE delete -- collectSpawnErrorContext
    // needs it to enrich SpawnFailed.error.
    const stderrSnapshot = trackedChildren.get(conversationId)?.stderrRing.snapshot() ?? []
    trackedChildren.delete(conversationId)
    unbindConversationFromProfile(conversationId)
    writePidRegistry()

    if (exitCode === 0) {
      log(`Headless child exited normally: PID ${pid} conv=${conversationId.slice(0, 8)} (${elapsedMs}ms)`)
      diag('spawn', `Child exited OK (${elapsedMs}ms)`, { conversationId: conversationId.slice(0, 8), pid })
      // Clean exit -- pre-flight warnings were false alarms; drop them.
      consumePreflightWarnings(conversationId)
    } else {
      const earlyFailure = elapsedMs < 5000
      log(
        `Headless child FAILED: PID ${pid} exit=${exitCode} elapsed=${elapsedMs}ms conv=${conversationId.slice(0, 8)}${earlyFailure ? ' (EARLY - likely hook/config failure)' : ''}`,
      )
      diag('spawn', `Child FAILED exit=${exitCode} elapsed=${elapsedMs}ms`, {
        conversationId: conversationId.slice(0, 8),
        pid,
        earlyFailure,
      })

      // Pre-flight warnings stashed before the spawn become likely-cause
      // hints once CC actually fails. Consume (clear) them here regardless
      // of whether we can reach the broker, so a later retry starts fresh.
      const preflightHints = consumePreflightWarnings(conversationId)

      // Report to broker
      if (activeWs?.readyState === WebSocket.OPEN) {
        const ctx = collectSpawnErrorContext(stderrSnapshot, cwd, conversationId, /*includeHeadlessLog*/ true)
        let errorDetail: string
        if (isResume && earlyFailure) {
          errorDetail = `Resume failed: process exited in ${elapsedMs}ms (exit ${exitCode}) - session may no longer exist or be corrupted`
        } else if (earlyFailure) {
          errorDetail = `Process exited in ${elapsedMs}ms (exit ${exitCode}) - likely hook or config failure`
        } else {
          errorDetail = `Process exited with code ${exitCode} after ${Math.round(elapsedMs / 1000)}s`
        }
        if (ctx.hint) errorDetail += `\n${ctx.hint}`
        const msg: SpawnFailed = {
          type: 'spawn_failed',
          conversationId,
          project: cwdToProjectUri(cwd),
          pid,
          exitCode,
          elapsedMs,
          error: errorDetail,
          ...(preflightHints ? { preflightHints } : {}),
          ...(ctx.stderrTail ? { stderrTail: ctx.stderrTail } : {}),
          ...(ctx.hookStage ? { hookStage: ctx.hookStage } : {}),
        }
        try {
          activeWs.send(JSON.stringify(msg))
        } catch {}
      }
    }
  })

  launchLog(jobId, 'Headless process started', 'ok', `PID ${pid}`)
  return { success: true, pid }
}

/**
 * Spawn an opencode-host subprocess for a conversation. Mirrors
 * spawnHeadlessDirect but launches `opencode-host` instead of `rclaude` and
 * sets OpenCode-specific env vars (OPENCODE_MODEL etc).
 *
 * The opencode-host binary connects to the broker over WebSocket, just like
 * rclaude does -- the broker can't tell them apart over the wire.
 */
function spawnOpenCodeHostDirect(opts: {
  bin: string
  cwd: string
  conversationId: string
  secret: string
  jobId?: string
  model?: string
  conversationName?: string
  conversationDescription?: string
  promptFile?: string
  env?: Record<string, string>
  toolPermission?: string
}): { success: boolean; error?: string; pid?: number } {
  const startTime = Date.now()
  launchLog(opts.jobId, 'Spawning opencode-host (direct)', 'info', `${opts.bin} model=${opts.model ?? 'default'}`)

  // Start from sanitized sentinel env, then add opencode-specific vars.
  const env: Record<string, string | undefined> = cleanSentinelEnv()
  env.RCLAUDE_SECRET = opts.secret
  env.RCLAUDE_CONVERSATION_ID = opts.conversationId
  env.RCLAUDE_HEADLESS = '1'
  if (opts.model) env.OPENCODE_MODEL = opts.model
  if (opts.conversationName) env.CLAUDWERK_CONVERSATION_NAME = opts.conversationName
  if (opts.conversationDescription) env.CLAUDWERK_CONVERSATION_DESCRIPTION = opts.conversationDescription
  if (opts.promptFile) env.RCLAUDE_INITIAL_PROMPT_FILE = opts.promptFile
  if (opts.toolPermission) env.OPENCODE_TOOL_PERMISSION = opts.toolPermission
  // Provider credentials forwarded transparently from the sentinel's env
  // (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, etc. -- already
  // present after cleanSentinelEnv since they don't match the strip rules).
  if (opts.env) Object.assign(env, opts.env)

  let proc: Subprocess
  try {
    proc = Bun.spawn([opts.bin], {
      cwd: opts.cwd,
      env,
      stdout: 'ignore',
      stderr: 'pipe',
    })
  } catch (e: unknown) {
    const err = `Bun.spawn failed: ${(e as Error).message}`
    launchLog(opts.jobId, 'Spawn failed', 'error', err)
    return { success: false, error: err }
  }
  const pid = proc.pid
  log(`opencode-host spawn: PID ${pid} conv=${opts.conversationId.slice(0, 8)} cwd=${opts.cwd}`)

  const child: TrackedChild = {
    proc,
    conversationId: opts.conversationId,
    pid,
    cwd: opts.cwd,
    startedAt: new Date().toISOString(),
    stderrRing: new RingBuffer<string>(30),
  }
  trackedChildren.set(opts.conversationId, child)
  writePidRegistry()
  captureChildStderr(proc, opts.conversationId)

  proc.exited.then(exitCode => {
    const elapsedMs = Date.now() - startTime
    // Snapshot stderr ring BEFORE delete (used to enrich SpawnFailed below).
    const stderrSnapshot = trackedChildren.get(opts.conversationId)?.stderrRing.snapshot() ?? []
    trackedChildren.delete(opts.conversationId)
    unbindConversationFromProfile(opts.conversationId)
    writePidRegistry()
    if (exitCode === 0) {
      log(`opencode-host exited normally: PID ${pid} conv=${opts.conversationId.slice(0, 8)} (${elapsedMs}ms)`)
    } else {
      const earlyFailure = elapsedMs < 5000
      log(
        `opencode-host FAILED: PID ${pid} exit=${exitCode} elapsed=${elapsedMs}ms conv=${opts.conversationId.slice(0, 8)}${earlyFailure ? ' (EARLY)' : ''}`,
      )
      if (activeWs?.readyState === WebSocket.OPEN) {
        const errCtx = collectSpawnErrorContext(
          stderrSnapshot,
          opts.cwd,
          opts.conversationId,
          /*includeHeadlessLog*/ false,
        )
        let detail = earlyFailure
          ? `opencode-host exited in ${elapsedMs}ms (exit ${exitCode}) - check OPENCODE_MODEL and provider API keys`
          : `opencode-host exited with code ${exitCode} after ${Math.round(elapsedMs / 1000)}s`
        if (errCtx.hint) detail += `\n${errCtx.hint}`
        const msg: SpawnFailed = {
          type: 'spawn_failed',
          conversationId: opts.conversationId,
          project: cwdToProjectUri(opts.cwd),
          pid,
          exitCode,
          elapsedMs,
          error: detail,
          ...(errCtx.stderrTail ? { stderrTail: errCtx.stderrTail } : {}),
          ...(errCtx.hookStage ? { hookStage: errCtx.hookStage } : {}),
        }
        try {
          activeWs.send(JSON.stringify(msg))
        } catch {}
      }
    }
  })

  launchLog(opts.jobId, 'opencode-host process started', 'ok', `PID ${pid}`)
  return { success: true, pid }
}

/**
 * Spawn an acp-host subprocess for a conversation. Mirrors
 * spawnOpenCodeHostDirect but launches `bin/acp-host` and parameterizes it
 * via the recipe registry (acp-recipes.ts). Recipe knowledge lives in the
 * sentinel; the host stays agent-agnostic.
 */
function spawnAcpHostDirect(opts: {
  bin: string
  cwd: string
  conversationId: string
  secret: string
  jobId?: string
  acpAgent: string
  model?: string
  conversationName?: string
  conversationDescription?: string
  promptFile?: string
  env?: Record<string, string>
  toolPermission?: string
  resumeSessionId?: string
}): { success: boolean; error?: string; pid?: number } {
  const startTime = Date.now()
  const recipe = getAcpRecipe(opts.acpAgent)
  if (!recipe) {
    const err = `No ACP recipe registered for agent "${opts.acpAgent}". Known: ${
      listAcpRecipes()
        .map(r => r.name)
        .join(', ') || 'none'
    }`
    launchLog(opts.jobId, 'acp recipe missing', 'error', err)
    return { success: false, error: err }
  }
  const resolvedAgentBin = recipe.resolveBin()
  if (!resolvedAgentBin) {
    const err = `${recipe.label} CLI not installed (recipe="${recipe.name}", expected: ${recipe.cmd[0]})`
    launchLog(opts.jobId, 'acp agent CLI missing', 'error', err)
    return { success: false, error: err }
  }
  launchLog(
    opts.jobId,
    `Spawning acp-host (${recipe.label})`,
    'info',
    `${opts.bin} agent=${recipe.name} model=${opts.model ?? 'default'}`,
  )

  const tier =
    opts.toolPermission === 'none' || opts.toolPermission === 'safe' || opts.toolPermission === 'full'
      ? opts.toolPermission
      : 'safe'
  const prepared = recipe.prepare?.({
    conversationId: opts.conversationId,
    cwd: opts.cwd,
    toolPermission: tier,
  }) ?? { env: {} as Record<string, string> }

  const env: Record<string, string | undefined> = cleanSentinelEnv()
  env.RCLAUDE_SECRET = opts.secret
  env.RCLAUDE_CONVERSATION_ID = opts.conversationId
  env.RCLAUDE_HEADLESS = '1'
  env.RCLAUDE_CWD = opts.cwd
  if (opts.conversationName) env.CLAUDWERK_CONVERSATION_NAME = opts.conversationName
  if (opts.conversationDescription) env.CLAUDWERK_CONVERSATION_DESCRIPTION = opts.conversationDescription
  if (opts.promptFile) env.RCLAUDE_INITIAL_PROMPT_FILE = opts.promptFile
  // ACP recipe envelope -- the host reads these to build the recipe object.
  env.ACP_AGENT_NAME = recipe.name
  env.ACP_AGENT_CMD_JSON = JSON.stringify(recipe.cmd)
  if (opts.model) env.ACP_AGENT_INITIAL_MODEL = opts.model
  env.ACP_TOOL_PERMISSION = tier
  if (opts.resumeSessionId) env.ACP_RESUME_SESSION_ID = opts.resumeSessionId
  // Recipe-supplied env (e.g. OPENCODE_CONFIG path).
  Object.assign(env, prepared.env)
  // Caller-supplied extras (provider keys, etc.) take precedence over
  // recipe env (so a user can override).
  if (opts.env) Object.assign(env, opts.env)

  let proc: Subprocess
  try {
    proc = Bun.spawn([opts.bin], {
      cwd: opts.cwd,
      env,
      stdout: 'ignore',
      stderr: 'pipe',
    })
  } catch (e: unknown) {
    const err = `Bun.spawn failed: ${(e as Error).message}`
    launchLog(opts.jobId, 'Spawn failed', 'error', err)
    prepared.cleanup?.()
    return { success: false, error: err }
  }
  const pid = proc.pid
  log(`acp-host spawn: PID ${pid} agent=${recipe.name} conv=${opts.conversationId.slice(0, 8)} cwd=${opts.cwd}`)

  const child: TrackedChild = {
    proc,
    conversationId: opts.conversationId,
    pid,
    cwd: opts.cwd,
    startedAt: new Date().toISOString(),
    stderrRing: new RingBuffer<string>(30),
  }
  trackedChildren.set(opts.conversationId, child)
  writePidRegistry()
  captureChildStderr(proc, opts.conversationId)

  proc.exited.then(exitCode => {
    const elapsedMs = Date.now() - startTime
    // Snapshot stderr ring BEFORE delete (used to enrich SpawnFailed below).
    const stderrSnapshot = trackedChildren.get(opts.conversationId)?.stderrRing.snapshot() ?? []
    trackedChildren.delete(opts.conversationId)
    unbindConversationFromProfile(opts.conversationId)
    writePidRegistry()
    prepared.cleanup?.()
    if (exitCode === 0) {
      log(`acp-host exited normally: PID ${pid} conv=${opts.conversationId.slice(0, 8)} (${elapsedMs}ms)`)
    } else {
      const earlyFailure = elapsedMs < 5000
      log(
        `acp-host FAILED: PID ${pid} exit=${exitCode} elapsed=${elapsedMs}ms conv=${opts.conversationId.slice(0, 8)}${earlyFailure ? ' (EARLY)' : ''}`,
      )
      if (activeWs?.readyState === WebSocket.OPEN) {
        const errCtx = collectSpawnErrorContext(
          stderrSnapshot,
          opts.cwd,
          opts.conversationId,
          /*includeHeadlessLog*/ false,
        )
        let detail = earlyFailure
          ? `acp-host (${recipe.name}) exited in ${elapsedMs}ms (exit ${exitCode}) -- check that ${recipe.cmd[0]} is installed and provider API keys are set`
          : `acp-host (${recipe.name}) exited with code ${exitCode} after ${Math.round(elapsedMs / 1000)}s`
        if (errCtx.hint) detail += `\n${errCtx.hint}`
        const msg: SpawnFailed = {
          type: 'spawn_failed',
          conversationId: opts.conversationId,
          project: cwdToProjectUri(opts.cwd, recipe.name),
          pid,
          exitCode,
          elapsedMs,
          error: detail,
          ...(errCtx.stderrTail ? { stderrTail: errCtx.stderrTail } : {}),
          ...(errCtx.hookStage ? { hookStage: errCtx.hookStage } : {}),
        }
        try {
          activeWs.send(JSON.stringify(msg))
        } catch {}
      }
    }
  })

  launchLog(opts.jobId, `acp-host process started (${recipe.label})`, 'ok', `PID ${pid}`)
  return { success: true, pid }
}

/**
 * Dispatch a Claude Code daemon worker via the cc-daemon socket `dispatch` op
 * (transport-reframe Phase 4 -- replaces the legacy `claude --bg` shell-out).
 * Covers NEW and RESUME. The sentinel MINTS the worker identity (short / nonce
 * / sessionId), assembles a typed `DispatchSpec` (`source:'fleet'`, claude
 * flags in `launch.args`/`flagArgs`, per-spawn env delta), and sends it over
 * the daemon control socket. The daemon answers `{short, pid, via}`; the minted
 * short is handed to bin/daemon-host via CLAUDWERK_DAEMON_SHORT so it can attach
 * to the worker's PTY. ATTACH never reaches this function (it has no dispatch).
 *
 * The dispatch-supplied `sessionId` becomes the worker's ccSessionId, but the
 * daemon-host still derives ccSessionId by OBSERVING the worker (unchanged
 * contract). DispatchSpec assembly + env bundling are pure helpers in
 * daemon-dispatch.ts (testable without booting the sentinel).
 */
async function dispatchDaemonWorker(opts: {
  cwd: string
  mode: 'new' | 'resume'
  prompt?: string
  resumeSessionId?: string
  model?: string
  name?: string
  settingsPath?: string
  mcpConfigPath?: string
  /** Sentinel-computed host MCP config -- leads the worker's `--mcp-config`. */
  hostMcpConfigPath?: string
  appendSystemPrompt?: string
  env?: Record<string, string>
  jobId?: string
  /** Resolved sentinel profile. Its `configDir` is injected as
   *  `CLAUDE_CONFIG_DIR` on the worker (skipped when it equals the implicit
   *  `~/.claude` -- see `shouldInjectConfigDir`). Its `env` (e.g.
   *  `ANTHROPIC_API_KEY` for alt accounts) is merged directly. */
  profile?: ResolvedProfile
}): Promise<{ short: string | null; sessionId: string; output: string }> {
  // Worker env DELTA only -- the daemon applies it over its own base env (the
  // live spike confirmed an empty env still boots a worker). Profile.env first,
  // then per-spawn env, then CLAUDE_CONFIG_DIR last (an explicit per-profile
  // dir cannot be overridden), skipping the implicit `~/.claude` default to
  // preserve CC's Keychain credential fallback.
  const workerEnv: Record<string, string> = {
    ...(opts.profile?.env ?? {}),
    ...(opts.env ?? {}),
  }
  const workerConfigDir = opts.profile?.configDir
  if (shouldInjectConfigDir(workerConfigDir)) workerEnv.CLAUDE_CONFIG_DIR = workerConfigDir
  // Long-lived OAuth token. This env is a DELTA applied over the daemon's own
  // base env, so a base ANTHROPIC_* can only be shadowed (empty string), not
  // deleted. See `applyOAuthTokenDelta`.
  applyOAuthTokenDelta(workerEnv, opts.profile?.oauthToken, opts.profile?.env)

  // Mint the worker identity. The daemon no longer prints a short -- claudewerk
  // owns it. sessionId is the worker's ccSessionId (32-hex), short/nonce 8-hex.
  const short = randomBytes(4).toString('hex')
  const nonce = randomBytes(4).toString('hex')
  const sessionId = randomBytes(16).toString('hex')

  let spec: DispatchSpec
  try {
    spec = buildDispatchSpec({
      mode: opts.mode,
      short,
      nonce,
      sessionId,
      cwd: opts.cwd,
      prompt: opts.prompt,
      resumeSessionId: opts.resumeSessionId,
      model: opts.model,
      name: opts.name,
      settingsPath: opts.settingsPath,
      mcpConfigPath: opts.mcpConfigPath,
      hostMcpConfigPath: opts.hostMcpConfigPath,
      appendSystemPrompt: opts.appendSystemPrompt,
      env: workerEnv,
    })
  } catch (e: unknown) {
    return { short: null, sessionId, output: `dispatch spec assembly failed: ${(e as Error).message}` }
  }

  // Profile-aware socket routing: cc-daemon is one-per-CLAUDE_CONFIG_DIR.
  // Pass the profile's configDir explicitly so the right roster is read
  // (default ~/.claude vs ~/.claude-work etc.). Bare resolveControlSocket()
  // would always read process.env -- wrong for cross-profile spawns.
  const sock = resolveControlSocket(socketEnvForProfile(opts.profile))
  if (!sock) {
    const profileLabel = opts.profile?.name ? ` (profile=${opts.profile.name})` : ''
    return {
      short: null,
      sessionId,
      output: `daemon dispatch: no Claude Code daemon control socket reachable${profileLabel}`,
    }
  }

  const flags = [
    `model=${opts.model ?? 'default'}`,
    opts.mode === 'resume' ? `resume=${opts.resumeSessionId}` : null,
    opts.settingsPath ? '+settings' : null,
    opts.mcpConfigPath ? '+mcp-config' : null,
    opts.appendSystemPrompt ? '+append-system-prompt' : null,
    Object.keys(workerEnv).length ? `+${Object.keys(workerEnv).length}env` : null,
    `short=${short}`,
  ]
    .filter(Boolean)
    .join(' ')
  launchLog(opts.jobId, `Dispatching daemon worker via socket op (${opts.mode})`, 'info', flags)

  try {
    const resp = await dispatch(sock, spec)
    if (resp.short !== short) {
      launchLog(opts.jobId, 'daemon dispatch short mismatch', 'info', `minted=${short} daemon=${resp.short}`)
    }
    return { short: resp.short, sessionId, output: `dispatch ok: short=${resp.short} pid=${resp.pid} via=${resp.via}` }
  } catch (e: unknown) {
    return { short: null, sessionId, output: `daemon dispatch op failed: ${(e as Error).message}` }
  }
}

/**
 * Spawn a daemon-host subprocess for a conversation. Mirrors
 * spawnOpenCodeHostDirect / spawnAcpHostDirect but launches `bin/daemon-host`,
 * which attaches to the already-dispatched daemon worker `daemonShort` rather
 * than spawning `claude` itself.
 */
function spawnDaemonHostDirect(opts: {
  bin: string
  cwd: string
  conversationId: string
  daemonShort: string
  /** Launch mode -- passed to daemon-host as CLAUDWERK_DAEMON_MODE. */
  mode: DaemonLaunchMode
  /** Daemon session id resumed from -- passed as CLAUDWERK_DAEMON_RESUME_SESSION
   *  when mode === 'resume'. The worker forks to a fresh id; this is the input. */
  resumeSessionId?: string
  secret: string
  jobId?: string
  conversationName?: string
  conversationDescription?: string
  env?: Record<string, string>
  /** Host MCP endpoint the daemon-host should bind its local /mcp server to
   *  (Phase 3b). Passed as `CLAUDWERK_MCP_ENDPOINT`; absent for ATTACH, where
   *  the worker was launched by someone else and we can't inject a config. */
  mcpEndpoint?: string
  /** Resolved sentinel profile. Its `configDir` is injected as
   *  `CLAUDE_CONFIG_DIR` on the daemon-host process (skipped for the implicit
   *  `~/.claude` default -- see `shouldInjectConfigDir`); `profile.env` is
   *  merged directly. */
  profile?: ResolvedProfile
}): { success: boolean; error?: string; pid?: number } {
  const startTime = Date.now()
  launchLog(
    opts.jobId,
    'Spawning daemon-host (direct)',
    'info',
    `${opts.bin} short=${opts.daemonShort} mode=${opts.mode}`,
  )

  const env: Record<string, string | undefined> = cleanSentinelEnv()
  env.RCLAUDE_SECRET = opts.secret
  env.RCLAUDE_CONVERSATION_ID = opts.conversationId
  env.RCLAUDE_HEADLESS = '1'
  env.RCLAUDE_CWD = opts.cwd
  env.CLAUDWERK_DAEMON_SHORT = opts.daemonShort
  env.CLAUDWERK_DAEMON_MODE = opts.mode
  if (opts.mode === 'resume' && opts.resumeSessionId) {
    env.CLAUDWERK_DAEMON_RESUME_SESSION = opts.resumeSessionId
  }
  if (opts.conversationName) env.CLAUDWERK_CONVERSATION_NAME = opts.conversationName
  if (opts.conversationDescription) env.CLAUDWERK_CONVERSATION_DESCRIPTION = opts.conversationDescription
  if (opts.mcpEndpoint) env[DAEMON_MCP_ENDPOINT_ENV] = opts.mcpEndpoint
  // Sentinel profile -- profile.env first (lowest precedence among per-spawn
  // overrides), then user-supplied opts.env, then CLAUDE_CONFIG_DIR last so
  // an explicit per-profile dir cannot be overridden by user env.
  if (opts.profile?.env) Object.assign(env, opts.profile.env)
  if (opts.env) Object.assign(env, opts.env)
  const hostConfigDir = opts.profile?.configDir
  if (shouldInjectConfigDir(hostConfigDir)) env.CLAUDE_CONFIG_DIR = hostConfigDir
  // Long-lived OAuth token for the profile (last, beats stray profile.env token).
  applyOAuthToken(env, opts.profile?.oauthToken, opts.profile?.env)

  let proc: Subprocess
  try {
    proc = Bun.spawn([opts.bin], { cwd: opts.cwd, env, stdout: 'ignore', stderr: 'pipe' })
  } catch (e: unknown) {
    const err = `Bun.spawn failed: ${(e as Error).message}`
    launchLog(opts.jobId, 'Spawn failed', 'error', err)
    return { success: false, error: err }
  }
  const pid = proc.pid
  log(`daemon-host spawn: PID ${pid} conv=${opts.conversationId.slice(0, 8)} short=${opts.daemonShort} cwd=${opts.cwd}`)

  const child: TrackedChild = {
    proc,
    conversationId: opts.conversationId,
    pid,
    cwd: opts.cwd,
    startedAt: new Date().toISOString(),
    stderrRing: new RingBuffer<string>(30),
  }
  trackedChildren.set(opts.conversationId, child)
  writePidRegistry()
  captureChildStderr(proc, opts.conversationId)

  proc.exited.then(exitCode => {
    const elapsedMs = Date.now() - startTime
    // Snapshot stderr ring BEFORE delete (used to enrich SpawnFailed below).
    const stderrSnapshot = trackedChildren.get(opts.conversationId)?.stderrRing.snapshot() ?? []
    trackedChildren.delete(opts.conversationId)
    unbindConversationFromProfile(opts.conversationId)
    writePidRegistry()
    if (exitCode === 0) {
      log(
        `daemon-host exited normally: PID ${pid} conv=${opts.conversationId.slice(0, 8)} ` +
          `short=${opts.daemonShort} mode=${opts.mode} elapsed=${elapsedMs}ms`,
      )
    } else {
      const earlyFailure = elapsedMs < 5000
      log(
        `daemon-host FAILED: PID ${pid} exit=${exitCode} elapsed=${elapsedMs}ms conv=${opts.conversationId.slice(0, 8)}${earlyFailure ? ' (EARLY)' : ''}`,
      )
      if (activeWs?.readyState === WebSocket.OPEN) {
        const errCtx = collectSpawnErrorContext(
          stderrSnapshot,
          opts.cwd,
          opts.conversationId,
          /*includeHeadlessLog*/ false,
        )
        let detail = earlyFailure
          ? `daemon-host exited in ${elapsedMs}ms (exit ${exitCode}) -- check the Claude Code daemon is running`
          : `daemon-host exited with code ${exitCode} after ${Math.round(elapsedMs / 1000)}s`
        if (errCtx.hint) detail += `\n${errCtx.hint}`
        const msg: SpawnFailed = {
          type: 'spawn_failed',
          conversationId: opts.conversationId,
          project: cwdToProjectUri(opts.cwd),
          pid,
          exitCode,
          elapsedMs,
          error: detail,
          ...(errCtx.stderrTail ? { stderrTail: errCtx.stderrTail } : {}),
          ...(errCtx.hookStage ? { hookStage: errCtx.hookStage } : {}),
        }
        try {
          activeWs.send(JSON.stringify(msg))
        } catch {}
      }
    }
  })

  launchLog(opts.jobId, 'daemon-host process started', 'ok', `PID ${pid}`)
  return { success: true, pid }
}

/** Read stderr from a child process, forward lines as diag entries, AND push
 *  them into the TrackedChild's ring buffer so an early-failure spawn_failed
 *  message can carry the actual cause instead of a generic exit-code string. */
async function captureChildStderr(proc: Subprocess, conversationId: string) {
  const stderr = proc.stderr
  if (!stderr) return
  const reader = (stderr as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pushLine = (line: string) => {
    diag('child-stderr', line, { wrapper: conversationId.slice(0, 8) })
    const child = trackedChildren.get(conversationId)
    child?.stderrRing.push(line)
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed) pushLine(trimmed)
      }
    }
    // Flush remaining
    const trimmed = buffer.trim()
    if (trimmed) pushLine(trimmed)
  } catch {
    // Stream closed, normal on exit
  }
}

/**
 * Build the `stderrTail` + `hookStage` pair for a SpawnFailed message.
 *
 * Combines (a) the host's stderr ring buffer captured via captureChildStderr
 * and (b) for headless spawns, the tail of CC's own
 * `.rclaude/settings/headless-{conversationId}.ndjsonl` log -- where hook
 * failures actually land. Deduplicates obvious overlap so the dashboard
 * doesn't show two copies of the same `ERR ...` line.
 *
 * Returns `{ stderrTail, hookStage, hint }`. `hint` is a single-line summary
 * suitable for appending to the human-readable `error` string (e.g.
 * `WorktreeCreate hook failed: fatal: a branch named '...' already exists`).
 */
function collectSpawnErrorContext(
  ringLines: string[],
  cwd: string,
  conversationId: string,
  includeHeadlessLog: boolean,
): { stderrTail?: string[]; hookStage?: string; hint?: string } {
  const ndjsonLines = includeHeadlessLog ? tailHeadlessNdjson(headlessNdjsonPath(cwd, conversationId), 20) : []

  // Dedup: drop any ring lines that already appear verbatim in the ndjson tail.
  const ndjsonSet = new Set(ndjsonLines)
  const merged = [...ringLines.filter(l => !ndjsonSet.has(l)), ...ndjsonLines]
  if (merged.length === 0) return {}

  const hookStage = parseHookStage(merged)
  const errLine = merged.findLast(l => /\b(ERR|ERROR|fatal:|hook failed)\b/i.test(l))
  const hint = errLine ? errLine.slice(0, 300) : undefined
  // Cap the wire payload so a pathological log can't bloat every spawn_failed.
  const stderrTail = merged.slice(-20)
  return { stderrTail, hookStage, hint }
}

// Find revive-session.sh in common locations.
// Two install layouts to support:
//   1. Compiled standalone: process.argv[0] is the binary itself (bin/sentinel
//      under the project root) -- look in ../scripts/.
//   2. Bundled JS via `bun install -g ./packages/sentinel`: process.argv[0] is
//      the bun runtime; the actual script is process.argv[1], a symlink chain
//      that ends at packages/sentinel/bin/sentinel inside the project root.
//      realpathSync follows the chain back to the source layout.
function findReviveScript(): string {
  const argv0Dir = dirname(resolve(process.argv[0]))
  const argv1 = process.argv[1]
  let scriptDir: string | null = null
  if (argv1) {
    try {
      scriptDir = dirname(realpathSync(argv1))
    } catch {}
  }
  const homeLocalBin = `${process.env.HOME || '/root'}/.local/bin`
  const candidates = [
    // Bundled JS dogfood/npm: packages/sentinel/bin/ -> project root scripts/
    scriptDir && resolve(scriptDir, '../../../scripts/revive-session.sh'),
    // Compiled standalone: bin/ -> project root scripts/
    resolve(argv0Dir, '../scripts/revive-session.sh'),
    // Compiled binary sitting at project root with sibling scripts/
    resolve(argv0Dir, 'scripts/revive-session.sh'),
    // Same dir as binary (fallback)
    resolve(argv0Dir, 'revive-session.sh'),
    scriptDir && resolve(scriptDir, 'revive-session.sh'),
    // Installed to ~/.local/bin
    resolve(homeLocalBin, 'revive-session.sh'),
  ].filter((p): p is string => typeof p === 'string')
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return candidates[0] // will fail at startup validation
}
const DEFAULT_REVIVE_SCRIPT = findReviveScript()

function parseArgs() {
  const args = process.argv.slice(2)
  let brokerUrl =
    process.env.CLAUDWERK_BROKER ?? process.env.RCLAUDE_BROKER ?? process.env.RCLAUDE_CONCENTRATOR ?? DEFAULT_BROKER_URL
  let secret =
    process.env.CLAUDWERK_SENTINEL_SECRET ??
    process.env.RCLAUDE_SENTINEL_SECRET ??
    process.env.CLAUDWERK_SECRET ??
    process.env.RCLAUDE_SECRET
  let verbose = false
  let reviveScript = DEFAULT_REVIVE_SCRIPT
  let spawnRoot = process.env.HOME || '/root'
  let noSpawn = false
  let configPath: string | undefined
  // Host-shell feature gate. Default ON; off via `--no-shell` or
  // `CLAUDWERK_NO_SHELL=1` (plan-host-shell.md 3.1 / 4.4). A raw `$SHELL` is
  // RCE as the host user, so the operator can hard-disable it per host.
  let noShell = process.env.CLAUDWERK_NO_SHELL === '1'

  const setVerbose = (i: number): number => {
    verbose = true
    return i
  }
  const showHelp = (): number => {
    printHelp()
    return process.exit(0)
  }
  // Flag -> handler returning the last consumed index (value flags advance past
  // their argument; boolean/terminal flags return `i` unchanged). Unknown args
  // are ignored, as the old chain did.
  const flagHandlers: Record<string, (i: number) => number> = {
    '--broker': i => {
      brokerUrl = args[i + 1] || DEFAULT_BROKER_URL
      return i + 1
    },
    '--secret': i => {
      secret = args[i + 1]
      return i + 1
    },
    '--revive-script': i => {
      reviveScript = resolve(args[i + 1])
      return i + 1
    },
    '--spawn-root': i => {
      spawnRoot = resolve(args[i + 1])
      return i + 1
    },
    '--no-spawn': i => {
      noSpawn = true
      return i
    },
    '--no-shell': i => {
      noShell = true
      return i
    },
    '--config': i => {
      configPath = resolve(args[i + 1])
      return i + 1
    },
    '-v': setVerbose,
    '--verbose': setVerbose,
    '--help': showHelp,
    '-h': showHelp,
  }

  for (let i = 0; i < args.length; i++) {
    const handler = flagHandlers[args[i]]
    if (handler) i = handler(i)
  }

  if (!secret) {
    secret =
      process.env.CLAUDWERK_SENTINEL_SECRET ??
      process.env.RCLAUDE_SENTINEL_SECRET ??
      process.env.CLAUDWERK_SECRET ??
      process.env.RCLAUDE_SECRET
  }

  return { brokerUrl, secret, verbose, reviveScript, spawnRoot, noSpawn, configPath, noShell }
}

function printHelp() {
  console.log(`
sentinel - Host-side sentinel for conversation revival and spawning

Connects to broker and listens for revive/spawn commands.
Headless conversations are spawned directly (Bun.spawn + PID tracking).
PTY/interactive conversations use tmux via revive-session.sh.

USAGE:
  sentinel [OPTIONS]
  sentinel profile <subcommand> [args...]   See \`sentinel profile --help\`

OPTIONS:
  --broker <url>   Broker WebSocket URL (default: ${DEFAULT_BROKER_URL})
  --secret <s>           Secret (CLAUDWERK_SENTINEL_SECRET or RCLAUDE_SECRET env)
  --revive-script <path> Path to revive-session.sh (default: auto-detected)
  --spawn-root <path>    Root directory for relative spawn paths (default: $HOME)
  --config <path>        Sentinel config (default: ${defaultConfigPath()})
  --no-shell             Disable the host-shell feature (CLAUDWERK_NO_SHELL=1)
  -v, --verbose          Enable verbose logging
  -h, --help             Show this help

Spawn security: directories need a .rclaude-spawn marker file at or above
the target path to allow spawning. Only one sentinel can be connected at a time.
`)
}

// Module-level WS ref for diag()
let activeWs: WebSocket | null = null
let ccVersionWatcher: CcVersionWatcher | null = null

// --- Host-shell infrastructure (plan-host-shell.md phase 2) -----------------
// The registry is process-lifetime (shells are FLOATING -- they survive control
// WS reconnects), the data WS + activity coalescer are lazy (open on the first
// shell, torn down when the last exits).

/** Whether this sentinel advertises `features.shell`. Set once at startup from
 *  `--no-shell` / `CLAUDWERK_NO_SHELL`. */
let shellFeatureEnabled = true
const shellRegistry = new ShellRegistry()
let shellDataWs: ShellDataWs | null = null
let shellActivityTimer: ReturnType<typeof setInterval> | null = null

function log(msg: string) {
  console.log(`[sentinel] ${msg}`)
}

function debug(msg: string, verbose: boolean) {
  if (verbose) console.log(`[sentinel] ${msg}`)
}

function diag(type: string, msg: string, args?: unknown) {
  log(`[diag] ${type}: ${msg}${args ? ` ${JSON.stringify(args)}` : ''}`)
  if (activeWs?.readyState === WebSocket.OPEN) {
    try {
      activeWs.send(
        JSON.stringify({
          type: 'sentinel_diag',
          entries: [{ t: Date.now(), type, msg, args }],
        }),
      )
    } catch {}
  }
}

/** Send a launch_log event tagged with jobId for request-scoped progress tracking */
function launchLog(jobId: string | undefined, step: string, status: 'info' | 'ok' | 'error' | 'warn', detail?: string) {
  if (!jobId) return
  log(`[job:${jobId.slice(0, 8)}] ${status}: ${step}${detail ? ` -- ${detail}` : ''}`)
  if (activeWs?.readyState === WebSocket.OPEN) {
    try {
      activeWs.send(JSON.stringify({ type: 'launch_log', jobId, step, status, detail, t: Date.now() }))
    } catch {}
  }
}

/** Send a sentinel -> broker message over the control WS, dropping it if the
 *  socket is down. Used by the host-shell control plane (`shell_exit`,
 *  `shell_activity`). */
function sendControl(msg: ShellExit | ShellActivity): void {
  if (activeWs?.readyState !== WebSocket.OPEN) return
  try {
    activeWs.send(JSON.stringify(msg))
  } catch {}
}

/**
 * Re-announce the full live host-shell roster to the broker on a control-WS
 * (re)connect. After a broker restart the broker's roster is EMPTY and nothing
 * else tells it these PTYs are still running -- this resync resurfaces them (and
 * lets the broker prune ones that died while we were disconnected). The data WS
 * is revived first so the byte plane re-pairs for the subsequent re-attach.
 * No-op when the shell feature is off or no shells are live.
 */
function sendShellResync(brokerUrl: string, secret: string): void {
  if (!shellFeatureEnabled || shellRegistry.count === 0) return
  if (activeWs?.readyState !== WebSocket.OPEN) return
  ensureShellInfra(brokerUrl, secret)
  const shells = shellRegistry.list().map(s => ({
    shellId: s.shellId,
    projectUri: s.projectUri,
    path: s.path,
    title: s.title,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
  }))
  const msg: ShellResync = { type: 'shell_resync', machineId: getMachineId(), shells }
  try {
    activeWs.send(JSON.stringify(msg))
    log(`[shell] resync sent -- ${shells.length} live shell(s) re-announced (machine ${getMachineId()})`)
  } catch {}
}

/**
 * Lazily bring up the dedicated shell-data WS + the activity coalescer on the
 * first live shell. The data WS carries the byte firehose (so it never
 * head-of-line-blocks the control WS); the coalescer flushes one
 * `shell_activity` per dirty shell at most ~4/sec (plan 4.3). Idempotent.
 */
function ensureShellInfra(brokerUrl: string, secret: string): ShellDataWs {
  if (!shellDataWs) {
    shellDataWs = new ShellDataWs({
      brokerUrl,
      secret,
      sentinelId: getMachineId(),
      log,
      handlers: {
        onInput: (shellId, data) => shellRegistry.write(shellId, data),
        onResize: (shellId, cols, rows) => shellRegistry.resize(shellId, cols, rows),
        onAttach: (shellId, cols, rows, replay) => {
          const dump = shellRegistry.attach(shellId, cols, rows)
          // Always emit a replay frame on attach so the client clears + repaints
          // to a known state, even when the ring is empty (done:true marks the
          // single/final chunk). Skip only when the broker did not request it.
          if (replay && dump !== null) shellDataWs?.sendReplay(shellId, dump, true)
        },
        onDetach: shellId => shellRegistry.detach(shellId),
      },
    })
  }
  shellDataWs.ensureOpen()
  if (!shellActivityTimer) {
    shellActivityTimer = setInterval(() => {
      const dirty = shellRegistry.drainActivity()
      const ts = Date.now()
      for (const shellId of dirty) sendControl({ type: 'shell_activity', shellId, ts })
    }, ACTIVITY_COALESCE_MS)
  }
  return shellDataWs
}

/** Tear down the data WS + coalescer once the last shell is gone (the data WS
 *  is opened on first shell, closed when the last exits -- plan section 3). */
function maybeTeardownShellInfra(): void {
  if (shellRegistry.count > 0) return
  if (shellActivityTimer) {
    clearInterval(shellActivityTimer)
    shellActivityTimer = null
  }
  if (shellDataWs) {
    shellDataWs.close()
    shellDataWs = null
  }
}

/**
 * Control-plane `shell_open`: spawn a scrubbed `$SHELL` PTY at the URI path.
 * The broker has already perm-checked URI write access + built the optimistic
 * roster entry from the request, so the sentinel just spawns and streams. On
 * spawn failure it emits `shell_exit` so the broker drops the roster entry.
 * The shell is FLOATING -- `conversationId` is transcript/grouping metadata
 * only, never an ownership key (broker boundary: route on projectUri/shellId).
 */
function handleShellOpen(m: ShellOpen, brokerUrl: string, secret: string): void {
  if (!shellFeatureEnabled) {
    log(`[shell] open REJECTED shellId=${m.shellId} -- shell feature disabled on this host`)
    sendControl({ type: 'shell_exit', shellId: m.shellId, code: 1 })
    return
  }
  const path = parseProjectUri(m.projectUri).path
  const title = m.title && m.title.length > 0 ? m.title : basename(path) || path
  ensureShellInfra(brokerUrl, secret)
  try {
    shellRegistry.spawn(
      {
        shellId: m.shellId,
        projectUri: m.projectUri,
        path,
        title,
        cols: m.cols,
        rows: m.rows,
        createdBy: m.conversationId ?? '',
      },
      shellSpawnCallbacks(m.projectUri),
    )
    log(
      `[shell] open shellId=${m.shellId} projectUri=${m.projectUri} path=${path} title="${title}" count=${shellRegistry.count}`,
    )
    diag('shell', 'open', { shellId: m.shellId, projectUri: m.projectUri, path })
  } catch (e) {
    log(`[shell] open FAILED shellId=${m.shellId} projectUri=${m.projectUri} error=${(e as Error).message}`)
    sendControl({ type: 'shell_exit', shellId: m.shellId, code: 1 })
    maybeTeardownShellInfra()
  }
}

/** Control-plane `shell_close`: kill the PTY. The roster removal happens via the
 *  resulting `shell_exit` (process exit -> onExit -> shell_exit). */
function handleShellClose(m: ShellClose): void {
  if (!shellRegistry.has(m.shellId)) {
    log(`[shell] close shellId=${m.shellId} -- unknown (already exited?)`)
    return
  }
  log(`[shell] close shellId=${m.shellId}`)
  shellRegistry.kill(m.shellId)
}

/** The PTY callbacks shared by every host-shell spawn path (broker `shell_open`
 *  and host-side `shell_originated`): stream bytes to the data WS, and on exit
 *  emit `shell_exit` + tear the data WS down if it was the last shell. */
function shellSpawnCallbacks(projectUri: string) {
  return {
    onData: (shellId: string, data: string) => shellDataWs?.sendData(shellId, data),
    onExit: (shellId: string, code: number) => {
      log(`[shell] exit shellId=${shellId} code=${code} projectUri=${projectUri}`)
      sendControl({ type: 'shell_exit', shellId, code })
      maybeTeardownShellInfra()
    },
  }
}

/** Mint a sentinel-side shellId (matches the web `sh_`+base36 shape). */
function mintShellId(): string {
  return `sh_${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`
}

/**
 * Spawn a host shell the SENTINEL originated (a `sentinel shell` invocation, via
 * the control socket) rather than a broker `shell_open`. Mints the shellId, builds
 * the `claude://default/{path}` URI, spawns the PTY, and announces it to the broker
 * (`shell_originated`) so it surfaces in the control panel. When the control WS is
 * down the shell still spawns locally and rides the next `shell_resync`. Returns
 * the shellId; throws (caught by the control handler) on a spawn failure.
 */
function spawnHostShell(absPath: string, title: string | undefined, brokerUrl: string, secret: string): string {
  if (!shellFeatureEnabled) throw new Error('host shells are disabled on this host (--no-shell)')
  const shellId = mintShellId()
  const projectUri = cwdToProjectUri(absPath)
  const ttl = title && title.length > 0 ? title : basename(absPath) || absPath
  ensureShellInfra(brokerUrl, secret)
  try {
    shellRegistry.spawn(
      { shellId, projectUri, path: absPath, title: ttl, cols: 80, rows: 24, createdBy: 'host' },
      shellSpawnCallbacks(projectUri),
    )
  } catch (e) {
    maybeTeardownShellInfra()
    throw e
  }
  if (activeWs?.readyState === WebSocket.OPEN) {
    const msg: ShellOriginated = {
      type: 'shell_originated',
      shellId,
      projectUri,
      path: absPath,
      title: ttl,
      createdBy: 'host',
      createdAt: Date.now(),
    }
    try {
      activeWs.send(JSON.stringify(msg))
    } catch {}
  }
  log(`[shell] originated shellId=${shellId} path=${absPath} title="${ttl}" count=${shellRegistry.count}`)
  diag('shell', 'originated', { shellId, projectUri, path: absPath })
  return shellId
}

/**
 * Sentinel-side daemon_launch_event emitter. EVERYTHING IS A STRUCTURED MESSAGE
 * -- the sentinel owns the two dispatch-side steps (`dispatch_requested` +
 * `worker_dispatched`) because they happen BEFORE the daemon-agent-host
 * process exists. The daemon-host emits the 6 attach-side steps from its own
 * buffer (`src/daemon-agent-host/launch-events.ts`). Late-attaching dashboards
 * see the dispatch steps via the broker's transcript-entry persistence path.
 *
 * Fires + logs even when activeWs is down (the LOG EVERYTHING covenant -- the
 * decision is logged regardless of whether the wire send succeeds). When the
 * broker receives this from a sentinel-role connection it accepts it (see
 * `daemon_launch_event` registration in src/broker/handlers/daemon.ts).
 */
function emitDaemonLaunchEvent(opts: {
  conversationId: string
  step: 'dispatch_requested' | 'worker_dispatched'
  daemonMode: 'new' | 'resume' | 'attach'
  short?: string
  detail?: string
  raw?: Record<string, unknown>
}) {
  log(
    `[daemon-launch] step=${opts.step} mode=${opts.daemonMode} conv=${opts.conversationId.slice(0, 8)}` +
      `${opts.short ? ` short=${opts.short}` : ''}${opts.detail ? ` -- ${opts.detail}` : ''}`,
  )
  if (activeWs?.readyState !== WebSocket.OPEN) return
  try {
    activeWs.send(
      JSON.stringify({
        type: 'daemon_launch_event',
        conversationId: opts.conversationId,
        step: opts.step,
        daemonMode: opts.daemonMode,
        short: opts.short,
        detail: opts.detail,
        raw: opts.raw,
        t: Date.now(),
      }),
    )
  } catch {}
}

/**
 * Revive a conversation. Headless conversations are spawned directly via Bun.spawn(),
 * PTY conversations use the external revive-session.sh script for tmux.
 *
 * Script exit codes: 0=continued, 1=fresh conversation, 2=dir not found, 3=tmux failed
 * Script stdout: TMUX_SESSION=<name> and CONTINUED=<true|false>
 */
async function reviveConversation(
  ccSessionId: string,
  cwd: string,
  conversationId: string,
  reviveScript: string,
  secret: string,
  verbose: boolean,
  mode?: 'fresh' | 'resume',
  headless = true,
  effort?: string,
  model?: string,
  conversationName?: string,
  autocompactPct?: number,
  maxBudgetUsd?: number,
  jobId?: string,
  adHocWorktree?: string,
  env?: Record<string, string>,
  agent?: string,
  profile?: ResolvedProfile,
  advisor?: string,
): Promise<ReviveResult & { tmuxPaneId?: string }> {
  const result: ReviveResult = {
    type: 'revive_result',
    ccSessionId,
    conversationId,
    project: cwdToProjectUri(cwd),
    jobId,
    success: false,
    continued: false,
  }

  // ─── Direct spawn for headless ─────────────────────────────
  if (headless) {
    const rclaudeBin = findRclaudeBinary()
    if (!rclaudeBin) {
      result.error = 'rclaude binary not found in PATH or known locations'
      launchLog(jobId, 'rclaude not found', 'error', result.error)
      return result
    }

    // Pre-flight: hard fails abort here; soft warnings are stashed and surfaced
    // by spawnHeadlessDirect's early-exit handler if CC dies during boot.
    const preflightOk = runPreflight({
      cwd,
      worktree: adHocWorktree,
      resumeCcSessionId: mode === 'resume' ? ccSessionId : undefined,
      conversationId,
      jobId,
      configDir: profile?.configDir,
    })
    if (!preflightOk) {
      result.error = 'Pre-flight check failed (see launch log)'
      return result
    }

    const args = buildHeadlessArgs({
      mode,
      resumeId: ccSessionId,
      resumeName: conversationName,
      effort,
      model,
      agent,
      maxBudgetUsd,
    })
    const spawnEnv = buildHeadlessEnv({
      secret,
      conversationId,
      ccSessionId,
      conversationName,
      autocompactPct,
      maxBudgetUsd,
      agent,
      advisor,
      effort,
      model,
      worktree: adHocWorktree,
      env,
      configDir: profile?.configDir,
      profileEnv: profile?.env,
      oauthToken: profile?.oauthToken,
    })

    launchLog(jobId, 'Reviving headless (direct spawn)', 'info', `mode=${mode || 'default'}`)
    const spawnRes = spawnHeadlessDirect(rclaudeBin, cwd, conversationId, args, spawnEnv, jobId, mode === 'resume')
    result.success = spawnRes.success
    result.error = spawnRes.error
    result.continued = mode === 'resume'
    return result
  }

  // ─── tmux path for PTY sessions ────────────────────────────
  // Pre-flight for the tmux revive path. Hard fails abort; soft warnings are
  // stashed but PTY mode has no early-exit detection plumbing -- they will
  // remain in the warning store unless explicitly drained.
  const ptyPreflightOk = runPreflight({
    cwd,
    worktree: adHocWorktree,
    resumeCcSessionId: mode === 'resume' ? ccSessionId : undefined,
    conversationId,
    jobId,
    configDir: profile?.configDir,
  })
  if (!ptyPreflightOk) {
    result.error = 'Pre-flight check failed (see launch log)'
    return result
  }

  const scriptArgs = [reviveScript, ccSessionId, cwd]
  if (mode) scriptArgs.push('--mode', mode)
  if (mode === 'resume') scriptArgs.push('--resume-id', ccSessionId)

  launchLog(jobId, 'Running revive script (tmux)', 'info', `mode=${mode || 'default'}`)
  debug(`Running: ${scriptArgs.join(' ')}`, verbose)

  const reviveEnv: Record<string, string | undefined> = {
    ...cleanSentinelEnv(),
    RCLAUDE_SECRET: secret,
    RCLAUDE_CONVERSATION_ID: conversationId,
    RCLAUDE_CC_SESSION_ID: ccSessionId,
    ...(effort ? { RCLAUDE_EFFORT: effort } : {}),
    ...(model ? { RCLAUDE_MODEL: model } : {}),
    ...(conversationName ? { CLAUDWERK_CONVERSATION_NAME: conversationName } : {}),
    ...(autocompactPct ? { RCLAUDE_AUTOCOMPACT_PCT: String(autocompactPct) } : {}),
    ...(maxBudgetUsd ? { RCLAUDE_MAX_BUDGET_USD: String(maxBudgetUsd) } : {}),
    ...(adHocWorktree ? { RCLAUDE_WORKTREE: adHocWorktree } : {}),
    ...(agent ? { RCLAUDE_AGENT: agent } : {}),
    ...(env && Object.keys(env).length ? { RCLAUDE_CUSTOM_ENV: JSON.stringify(env) } : {}),
    // Sentinel profile -- inject CLAUDE_CONFIG_DIR + profile.env DIRECTLY
    // so revive-session.sh, the tmux child, and the rclaude binary all see
    // them as real env. Profile-Env Boundary: never echo over the wire.
    // Implicit default (~/.claude): omit CLAUDE_CONFIG_DIR so CC's Keychain
    // credential fallback still fires -- see `shouldInjectConfigDir`.
    ...(shouldInjectConfigDir(profile?.configDir) ? { CLAUDE_CONFIG_DIR: profile.configDir } : {}),
    ...(profile?.env ?? {}),
    // Tell revive-session.sh which of the above to re-export across the tmux
    // boundary via `tmux -e` (a new pane inherits the tmux server's stale env,
    // not this one). Names only -- values stay in the spawned process env.
    ...(ptyCrossBoundaryEnvKeys(profile, env) ? { CLAUDWERK_PTY_ENV_KEYS: ptyCrossBoundaryEnvKeys(profile, env) } : {}),
  }
  // NO OAuth-token injection on the PTY/interactive path. The setup-token is
  // inference-only -- it authenticates `claude -p` (headless) but CANNOT
  // establish an interactive subscription SESSION (CC shows "API Usage Billing
  // / Not logged in" and the session degrades). Interactive must use the
  // configDir's keychain `/login` creds. See `oauth-token-env.ts` header.

  const proc = Bun.spawnSync(scriptArgs, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: reviveEnv,
  })

  const stdout = proc.stdout.toString().trim()
  const stderr = proc.stderr.toString().trim()
  const exitCode = proc.exitCode

  if (verbose && stdout) debug(`Script stdout: ${stdout}`, verbose)
  if (stderr) debug(`Script stderr: ${stderr}`, verbose)

  // Parse output lines for TMUX_SESSION=, PANE_ID=, CONTINUED=
  let tmuxPaneId: string | undefined
  for (const line of stdout.split('\n')) {
    const [key, value] = line.split('=', 2)
    if (key === 'TMUX_SESSION') result.tmuxSession = value
    if (key === 'PANE_ID') tmuxPaneId = value
    if (key === 'CONTINUED') result.continued = value === 'true'
  }

  switch (exitCode) {
    case 0: // success, continued existing conversation
      result.success = true
      result.continued = true
      launchLog(jobId, 'Conversation revived', 'ok', `continued=true tmux=${result.tmuxSession}`)
      break
    case 1: // success, fresh conversation (resume failed or not requested)
      result.success = true
      result.continued = false
      launchLog(jobId, 'Fresh conversation started', 'ok', `tmux=${result.tmuxSession}`)
      break
    case 2: // directory not found
      result.error = stderr || `Directory not found: ${cwd}`
      launchLog(jobId, 'Directory not found', 'error', result.error)
      break
    case 3: // tmux spawn failed
      result.error = stderr || 'Failed to create tmux session'
      launchLog(jobId, 'tmux spawn failed', 'error', result.error)
      break
    default:
      result.error = stderr || `Script exited with code ${exitCode}`
      launchLog(jobId, 'Script failed', 'error', result.error)
  }

  return Object.assign(result, { tmuxPaneId })
}

/**
 * Expand path shortcuts: ~ -> $HOME, relative paths -> spawnRoot
 */

/**
 * Check if a directory is spawn-approved.
 * Walks up from `cwd` looking for a `.rclaude-spawn` marker file.
 * If found at or above the target, spawn is allowed.
 */
function isSpawnApproved(cwd: string): boolean {
  let dir = resolve(cwd)
  const root = resolve('/')
  while (true) {
    if (existsSync(resolve(dir, '.rclaude-spawn'))) return true
    if (dir === root) break
    dir = dirname(dir)
  }
  return false
}

/**
 * Spawn a new rclaude conversation at the given cwd.
 * Headless conversations use direct Bun.spawn(), PTY conversations use tmux via revive-session.sh.
 */
async function spawnConversation(
  cwd: string,
  conversationId: string,
  reviveScript: string,
  secret: string,
  _verbose: boolean,
  mkdir = false,
  mode?: 'fresh' | 'resume',
  resumeId?: string,
  headless = true,
  effort?: string,
  model?: string,
  bare = false,
  repl = false,
  conversationName?: string,
  conversationDescription?: string,
  permissionMode?: string,
  autocompactPct?: number,
  maxBudgetUsd?: number,
  prompt?: string,
  adHoc = false,
  adHocTaskId?: string,
  worktree?: string,
  jobId?: string,
  leaveRunning = false,
  includePartialMessages?: boolean,
  env?: Record<string, string>,
  agent?: string,
  appendSystemPrompt?: string,
  profile?: ResolvedProfile,
  /** Backend-general `--settings` path (transport-reframe Phase 2). */
  settingsPath?: string,
  /** Backend-general `--mcp-config` path (transport-reframe Phase 2). */
  mcpConfigPath?: string,
  /** Advisor model (CC 2.1.170 server-side advisor tool). */
  advisor?: string,
): Promise<{ success: boolean; error?: string; tmuxSession?: string; tmuxPaneId?: string }> {
  launchLog(jobId, 'Validating directory', 'info', cwd)

  // Diagnostic dump
  const rclaudeBin = findRclaudeBinary()
  diag('spawn', 'Starting spawn', {
    cwd,
    conversationId,
    mkdir,
    headless,
    reviveScript,
    reviveScriptExists: existsSync(reviveScript),
    secretSet: !!secret,
    brokerUrl: process.env.RCLAUDE_BROKER || 'UNSET',
    rclaude: rclaudeBin || 'NOT FOUND',
    PATH: process.env.PATH,
  })

  if (!existsSync(cwd)) {
    if (mkdir) {
      try {
        mkdirSync(cwd, { recursive: true })
        launchLog(jobId, 'Created directory', 'ok', cwd)
        diag('spawn', 'Created directory', { cwd })
      } catch (e: unknown) {
        const err = `Failed to create directory: ${(e as Error).message}`
        launchLog(jobId, 'Directory creation failed', 'error', err)
        return { success: false, error: err }
      }
    } else {
      launchLog(jobId, 'Directory not found', 'error', cwd)
      return { success: false, error: `Directory not found: ${cwd}` }
    }
  } else {
    launchLog(jobId, 'Directory validated', 'ok')
  }

  if (!isSpawnApproved(cwd)) {
    const err = `Spawn not allowed: no .rclaude-spawn marker at or above ${cwd}`
    launchLog(jobId, 'Spawn not approved', 'error', err)
    return { success: false, error: err }
  }
  launchLog(jobId, 'Spawn approved', 'ok')

  // Write ad-hoc prompt to file (prompt content can contain anything, files avoid shell escaping issues)
  if (adHoc) {
    diag('spawn', '[ad-hoc] Starting ad-hoc spawn', {
      taskId: adHocTaskId,
      worktree,
      promptLength: prompt?.length || 0,
      conversationName,
    })
  }
  let promptFile: string | undefined
  if (prompt) {
    promptFile = secureTmpPath(`rclaude-adhoc-${conversationId}`)
    try {
      await writeSecureFile(promptFile, prompt)
      launchLog(jobId, 'Prompt file written', 'ok', `${prompt.length} chars`)
      diag('spawn', 'Wrote prompt file', { path: promptFile, length: prompt.length })
    } catch (e: unknown) {
      diag('spawn', 'Failed to write prompt file', { error: (e as Error).message })
      launchLog(jobId, 'Prompt file failed', 'error', (e as Error).message)
      promptFile = undefined
    }
  }

  // ─── Direct spawn for headless ─────────────────────────────
  if (headless) {
    if (!rclaudeBin) {
      const err = 'rclaude binary not found in PATH or known locations'
      launchLog(jobId, 'rclaude not found', 'error', err)
      return { success: false, error: err }
    }

    // Pre-flight: validate the spawn target before paying for a process boot.
    // Hard fails return immediately; soft warnings are stashed and surface
    // via spawnHeadlessDirect's early-exit handler if CC then dies during boot.
    const preflightOk = runPreflight({
      cwd,
      worktree,
      resumeCcSessionId: mode === 'resume' ? resumeId : undefined,
      conversationId,
      jobId,
      configDir: profile?.configDir,
    })
    if (!preflightOk) {
      return { success: false, error: 'Pre-flight check failed (see launch log)' }
    }

    const args = buildHeadlessArgs({
      mode,
      resumeId,
      resumeName: conversationName,
      effort,
      model,
      agent,
      worktree,
      maxBudgetUsd,
      permissionMode,
    })
    const spawnEnv = buildHeadlessEnv({
      secret,
      conversationId,
      conversationName,
      conversationDescription,
      permissionMode,
      autocompactPct,
      maxBudgetUsd,
      agent,
      advisor,
      adHoc,
      adHocTaskId,
      leaveRunning,
      promptFile,
      worktree,
      effort,
      model,
      bare,
      repl,
      includePartialMessages,
      appendSystemPrompt,
      settingsPath,
      mcpConfigPath,
      env,
      configDir: profile?.configDir,
      profileEnv: profile?.env,
      oauthToken: profile?.oauthToken,
    })

    const spawnRes = spawnHeadlessDirect(rclaudeBin, cwd, conversationId, args, spawnEnv, jobId)
    if (spawnRes.success) {
      launchLog(jobId, 'Waiting for conversation to connect', 'info')
    }
    return { success: spawnRes.success, error: spawnRes.error }
  }

  // ─── tmux path for PTY sessions ────────────────────────────

  // Pre-flight before tmux spawn. Same logic as headless, but the warning
  // surface for early-exit doesn't apply here (tmux owns the lifecycle).
  const ptyPreflightOk = runPreflight({
    cwd,
    worktree,
    resumeCcSessionId: mode === 'resume' ? resumeId : undefined,
    conversationId,
    jobId,
    configDir: profile?.configDir,
  })
  if (!ptyPreflightOk) {
    return { success: false, error: 'Pre-flight check failed (see launch log)' }
  }

  // appendSystemPrompt can be up to 16 KiB of arbitrary text (quotes, newlines,
  // `$`, backticks). Embedding that in the revive-session.sh CMD_PREFIX would
  // corrupt it (sanitizing strips the very chars a prompt may need). So write it
  // to a file and pass only the (shell-safe) PATH -- the same pattern the initial
  // prompt uses. The agent host reads CLAUDWERK_APPEND_SYSTEM_PROMPT_FILE.
  let appendSystemPromptFile: string | undefined
  if (appendSystemPrompt) {
    appendSystemPromptFile = secureTmpPath(`rclaude-append-sysprompt-${conversationId}`)
    try {
      await writeSecureFile(appendSystemPromptFile, appendSystemPrompt)
      launchLog(jobId, 'Append-system-prompt file written', 'ok', `${appendSystemPrompt.length} chars`)
    } catch (e: unknown) {
      diag('spawn', 'Failed to write append-system-prompt file', { error: (e as Error).message })
      appendSystemPromptFile = undefined
    }
  }

  // Sanitize strings that will be embedded in shell commands by revive-session.sh.
  // The env vars are safe in Bun.spawnSync, but the shell script injects them into
  // CMD_PREFIX which gets nested through tmux -> /bin/sh -> /bin/zsh. Quotes,
  // backticks, backslashes, and dollar signs break the quoting chain.
  const shellSafe = (s: string) => s.replace(/['"\\`$]/g, '')

  // Use "spawn-<timestamp>" as synthetic ID (revive-session.sh uses it for tmux window naming)
  const syntheticId = `spawn-${Date.now()}`
  const scriptArgs = [reviveScript, syntheticId, cwd]
  if (mode) scriptArgs.push('--mode', mode)
  if (mode === 'resume' && resumeId) scriptArgs.push('--resume-id', resumeId)
  if (mode === 'resume' && conversationName) scriptArgs.push('--resume-name', conversationName)
  const scriptEnv = {
    ...cleanSentinelEnv(),
    RCLAUDE_SECRET: secret,
    RCLAUDE_CONVERSATION_ID: conversationId,
    ...(effort ? { RCLAUDE_EFFORT: effort } : {}),
    ...(model ? { RCLAUDE_MODEL: model } : {}),
    ...(bare ? { RCLAUDE_BARE: '1' } : {}),
    ...(repl ? { CLAUDE_CODE_REPL: 'true' } : {}),
    ...(conversationName ? { CLAUDWERK_CONVERSATION_NAME: shellSafe(conversationName) } : {}),
    ...(conversationDescription ? { CLAUDWERK_CONVERSATION_DESCRIPTION: shellSafe(conversationDescription) } : {}),
    ...(permissionMode ? { RCLAUDE_PERMISSION_MODE: permissionMode } : {}),
    ...(autocompactPct ? { RCLAUDE_AUTOCOMPACT_PCT: String(autocompactPct) } : {}),
    ...(maxBudgetUsd ? { RCLAUDE_MAX_BUDGET_USD: String(maxBudgetUsd) } : {}),
    ...(adHoc ? { RCLAUDE_ADHOC: '1', RCLAUDE_CHANNELS: '0' } : {}),
    ...(adHocTaskId ? { RCLAUDE_ADHOC_TASK_ID: adHocTaskId } : {}),
    ...(leaveRunning ? { RCLAUDE_LEAVE_RUNNING: '1' } : {}),
    ...(promptFile ? { RCLAUDE_INITIAL_PROMPT_FILE: promptFile } : {}),
    ...(includePartialMessages === false ? { RCLAUDE_INCLUDE_PARTIAL_MESSAGES: '0' } : {}),
    ...(worktree ? { RCLAUDE_WORKTREE: shellSafe(worktree) } : {}),
    ...(agent ? { RCLAUDE_AGENT: shellSafe(agent) } : {}),
    // Backend-general config injection (transport-reframe Phase 2). Paths are
    // shell-safe; revive-session.sh single-quotes + sanitizes them in CMD_PREFIX.
    // appendSystemPrompt rides as a FILE path (see appendSystemPromptFile above).
    ...(settingsPath ? { CLAUDWERK_SETTINGS_PATH: shellSafe(settingsPath) } : {}),
    ...(mcpConfigPath ? { CLAUDWERK_MCP_CONFIG_PATH: shellSafe(mcpConfigPath) } : {}),
    ...(appendSystemPromptFile ? { CLAUDWERK_APPEND_SYSTEM_PROMPT_FILE: appendSystemPromptFile } : {}),
    ...(env && Object.keys(env).length ? { RCLAUDE_CUSTOM_ENV: JSON.stringify(env) } : {}),
    // Sentinel profile -- CLAUDE_CONFIG_DIR + profile.env injected DIRECTLY
    // so revive-session.sh, the tmux shell, and rclaude all see them as real
    // env vars. Profile-Env Boundary: never echo over the wire.
    // Implicit default (~/.claude): omit CLAUDE_CONFIG_DIR so CC's Keychain
    // credential fallback still fires -- see `shouldInjectConfigDir`.
    ...(shouldInjectConfigDir(profile?.configDir) ? { CLAUDE_CONFIG_DIR: profile.configDir } : {}),
    ...(profile?.env ?? {}),
    // Tell revive-session.sh which of the above to re-export across the tmux
    // boundary via `tmux -e` (a new pane inherits the tmux server's stale env,
    // not this one). Names only -- values stay in the spawned process env.
    ...(ptyCrossBoundaryEnvKeys(profile, env) ? { CLAUDWERK_PTY_ENV_KEYS: ptyCrossBoundaryEnvKeys(profile, env) } : {}),
  }
  // NO OAuth-token injection on the PTY/interactive path -- the setup-token is
  // inference-only and cannot establish an interactive subscription session.
  // Interactive uses the configDir's keychain `/login` creds. See the headless
  // path + `oauth-token-env.ts` for where the token IS injected.

  launchLog(jobId, 'Starting tmux session', 'info')
  diag('spawn', 'Running revive script', { args: scriptArgs })

  const proc = Bun.spawnSync(scriptArgs, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: scriptEnv,
  })

  const stdout = proc.stdout.toString().trim()
  const stderr = proc.stderr.toString().trim()
  const exitCode = proc.exitCode

  // After spawn, check if the tmux session/window actually exists
  const tmuxCheck = Bun.spawnSync([TMUX_BIN, 'list-windows', '-t', 'claudewerk'])
  const tmuxWindows = tmuxCheck.stdout.toString().trim()

  diag('spawn', 'Script completed', {
    exitCode,
    stdout,
    stderr: stderr || undefined,
    tmuxWindowsAfter: tmuxWindows || '(none/session gone)',
  })

  let tmuxSession: string | undefined
  let tmuxPaneId: string | undefined
  for (const line of stdout.split('\n')) {
    const [key, value] = line.split('=', 2)
    if (key === 'TMUX_SESSION') tmuxSession = value
    if (key === 'PANE_ID') tmuxPaneId = value
  }

  if (exitCode === 0) {
    launchLog(jobId, 'tmux session created', 'ok', `tmux=${tmuxSession} pane=${tmuxPaneId || 'n/a'}`)
    return { success: true, tmuxSession, tmuxPaneId }
  }
  const err = stderr || `Script exited with code ${exitCode}`
  launchLog(jobId, 'tmux spawn failed', 'error', err)
  return { success: false, error: err }
}

/**
 * List directories at a path for the dashboard's path autocomplete.
 */
function listDirs(dirPath: string): { dirs: string[]; error?: string } {
  try {
    const resolved = resolve(dirPath)
    if (!existsSync(resolved)) {
      return { dirs: [], error: `Path not found: ${dirPath}` }
    }
    const stat = statSync(resolved)
    if (!stat.isDirectory()) {
      return { dirs: [], error: `Not a directory: ${dirPath}` }
    }
    const entries = readdirSync(resolved, { withFileTypes: true })
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort()
    return { dirs }
  } catch (err) {
    return { dirs: [], error: `${err}` }
  }
}

// ─── Per-Profile Usage Polling ────────────────────────────────────
//
// Token discovery + parser + per-profile poll all live in `./usage-poller`
// (extracted for testability). This file just owns the timer + WS plumbing,
// the cycle log lines, and the in-process snapshot map that Smart Balance
// will read from in Phase 3.
//
// Each cycle iterates every profile in the sentinel config (default + alts),
// emits ONE batched `sentinel_usage_report` upstream, and -- for one
// release of back-compat -- also emits the legacy `usage_update` derived
// from the default profile's snapshot so older brokers / panels keep working.

const USAGE_POLL_INTERVAL_MS = 3 * 60 * 1000 // 3 minutes

// Rate-limit backoff. The usage endpoint throttles per-account; re-polling
// inside an active window keeps the bucket warm and never lets it clear. On a
// 429 we honor `retry-after` (parsed onto the snapshot) and skip polling that
// profile until the window expires (+ a small margin so we land just after it).
const RATE_LIMIT_BACKOFF_MARGIN_MS = 5_000
const RATE_LIMIT_FALLBACK_BACKOFF_MS = 5 * 60 * 1000 // used when 429 carries no retry-after
const RATE_LIMIT_MAX_BACKOFF_MS = 30 * 60 * 1000 // cap a garbage/hostile retry-after

/** How long to wait before re-polling a profile that just returned 429. */
function computeRateLimitBackoffMs(retryAfterMs: number | undefined): number {
  const base = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : RATE_LIMIT_FALLBACK_BACKOFF_MS
  return Math.min(RATE_LIMIT_MAX_BACKOFF_MS, base + RATE_LIMIT_BACKOFF_MARGIN_MS)
}

let usagePollTimer: ReturnType<typeof setInterval> | null = null

/** In-process latest-per-profile snapshots, populated by the polling cycle.
 *  Phase 3 reads this from `pickProfile` for Smart Balance. Holds errored
 *  snapshots too (the wire report + panel need to show throttles honestly). */
const latestProfileUsage = new Map<string, ProfileUsageSnapshot>()

/** Last ERROR-FREE snapshot per profile (has both windows). Survives a 429 so
 *  the Balanced picker can carry forward real headroom while the usage API
 *  throttles the probe -- see `usage-headroom.ts` / `buildPickerUsageSource`. */
const lastGoodProfileUsage = new Map<string, ProfileUsageSnapshot>()

/** Profile name -> epoch ms until which polling is suppressed (429 backoff). */
const profileBackoffUntil = new Map<string, number>()

/** Path to the on-disk last-good cache. Set when polling starts; null disables
 *  persistence (before boot / in tests that don't wire it). */
let usageCachePath: string | null = null

/** Persist the current last-good snapshots to disk (best-effort). Lets a cold
 *  start of an always-throttled account (the shared default login) re-broadcast
 *  its previous reading instead of a blank row -- see `usage-cache.ts`. */
function persistLastGoodUsage(): void {
  if (!usageCachePath) return
  const ok = saveUsageCache(lastGoodProfileUsage.values(), { path: usageCachePath })
  if (!ok) diag('usage', 'failed to persist last-good usage cache', { path: usageCachePath })
}

/** The snapshot to put in the wire report when the live poll is unavailable
 *  (throttled or failed). Prefers a stale-flagged carry-forward of the last
 *  good reading so the panel shows "usage Nm old" instead of blanking; falls
 *  back to the honest error snapshot when there's no recent good reading. The
 *  carry-forward itself is observable via the snapshot's `stale` flag in the
 *  report plus the `throttled`/error diag from the poll path. */
function displaySnapshotFor(name: string, cycleStart: number, fresh?: ProfileUsageSnapshot): ProfileUsageSnapshot {
  return (
    buildCarriedSnapshot(lastGoodProfileUsage.get(name), cycleStart) ??
    fresh ??
    latestProfileUsage.get(name) ?? { profile: name, authed: false, polledAt: cycleStart }
  )
}

/** Read-only view of the latest snapshots. Exported for Smart Balance + tests. */
export function getLatestProfileUsage(): ReadonlyMap<string, ProfileUsageSnapshot> {
  return latestProfileUsage
}

/** Read-only view of the last-good snapshots (429 carry-forward source). */
export function getLastGoodProfileUsage(): ReadonlyMap<string, ProfileUsageSnapshot> {
  return lastGoodProfileUsage
}

/** LOG-EVERYTHING covenant: one structured line per profile per cycle. */
function logProfilePollResult(snap: ProfileUsageSnapshot): void {
  if (snap.error) {
    diag('usage', `[${snap.profile}] error`, {
      kind: snap.error.kind,
      status: snap.error.status,
      detail: snap.error.detail,
      authed: snap.authed,
    })
    return
  }
  diag('usage', `[${snap.profile}] 5h=${snap.fiveHour?.usedPercent}% 7d=${snap.sevenDay?.usedPercent}%`, {
    authed: snap.authed,
    opus: snap.sevenDayOpus?.usedPercent,
    sonnet: snap.sevenDaySonnet?.usedPercent,
  })
}

/** Arm or clear the 429 backoff window for a profile based on its snapshot. */
function updateBackoff(name: string, cycleStart: number, snap: ProfileUsageSnapshot): void {
  if (snap.error?.kind === 'http' && snap.error.status === 429) {
    const backoffMs = computeRateLimitBackoffMs(snap.error.retryAfterMs)
    profileBackoffUntil.set(name, cycleStart + backoffMs)
    diag('usage', `[${name}] rate limited, backing off`, {
      retryAfterMs: snap.error.retryAfterMs,
      backoffMs,
      resumeAt: cycleStart + backoffMs,
    })
  } else if (profileBackoffUntil.has(name)) {
    profileBackoffUntil.delete(name)
    diag('usage', `[${name}] backoff cleared`, { status: snap.error?.status })
  }
}

/** Returns the last snapshot to re-emit if the profile is still inside its 429
 *  backoff window (polling suppressed), else null to poll normally. Re-emitting
 *  keeps the report complete so the panel keeps showing the throttled row. */
function takeBackoffSnapshot(name: string, cycleStart: number): ProfileUsageSnapshot | null {
  const until = profileBackoffUntil.get(name) ?? 0
  if (cycleStart >= until) return null
  diag('usage', `[${name}] throttled, skipping poll`, {
    retryInMs: until - cycleStart,
    until,
    status: latestProfileUsage.get(name)?.error?.status,
  })
  return displaySnapshotFor(name, cycleStart)
}

/** Run one profile's poll + record the result. Never throws -- a poll
 *  failure becomes a structured snapshot so the cycle continues. */
async function pollOneProfileSafely(
  profile: { name: string; configDir: string },
  cycleStart: number,
): Promise<ProfileUsageSnapshot> {
  try {
    const snap = await pollProfileUsage(profile)
    latestProfileUsage.set(profile.name, snap)
    // Preserve the last error-free reading so the picker can carry it forward
    // when the next poll is throttled (429) -- a probe failure must not blank a
    // healthy profile out of the Balanced ranking. See `usage-headroom.ts`.
    if (snapshotHasWindows(snap)) {
      lastGoodProfileUsage.set(profile.name, snap)
      persistLastGoodUsage()
    }
    logProfilePollResult(snap)
    updateBackoff(profile.name, cycleStart, snap)
    return snap
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diag('usage', `[${profile.name}] uncaught poll error: ${msg}`)
    const errored: ProfileUsageSnapshot = {
      profile: profile.name,
      authed: false,
      polledAt: cycleStart,
      error: { kind: 'network', detail: msg },
    }
    latestProfileUsage.set(profile.name, errored)
    return errored
  }
}

function startProfileUsagePolling(ws: WebSocket, verbose: boolean, config: SentinelConfig) {
  stopUsagePolling()

  const profiles = Object.values(config.profiles).map(p => ({ name: p.name, configDir: p.configDir }))
  const intervalMin = USAGE_POLL_INTERVAL_MS / 60_000

  // Seed last-good from disk so a cold start of a throttled account (the shared
  // default login that gets 429'd on the first poll) re-broadcasts its previous
  // reading instead of a blank row -- see `usage-cache.ts`.
  usageCachePath = defaultUsageCachePath()
  let seeded = 0
  for (const snap of loadUsageCache({ path: usageCachePath })) {
    lastGoodProfileUsage.set(snap.profile, snap)
    seeded++
  }

  log(`Starting per-profile usage polling (${intervalMin}min interval, ${profiles.length} profile(s))`)
  diag('usage', `Polling started`, { profiles: profiles.map(p => p.name), seededFromCache: seeded })

  async function doPoll() {
    const cycleStart = Date.now()
    const snapshots: ProfileUsageSnapshot[] = []
    for (const profile of profiles) {
      const throttled = takeBackoffSnapshot(profile.name, cycleStart)
      if (throttled) {
        snapshots.push(throttled)
        continue
      }
      // Poll. A failed poll (429 on the first cycle before backoff is armed, or
      // a network blip) still carries forward the last-good reading instead of
      // broadcasting a blank/errored row -- see `displaySnapshotFor`.
      const fresh = await pollOneProfileSafely(profile, cycleStart)
      snapshots.push(snapshotHasWindows(fresh) ? fresh : displaySnapshotFor(profile.name, cycleStart, fresh))
    }

    if (ws.readyState !== WebSocket.OPEN) return

    const report = buildSentinelUsageReport(snapshots, cycleStart)
    ws.send(JSON.stringify(report))
    debug(`Usage report sent: ${snapshots.length} profile(s)`, verbose)

    // Legacy back-compat: also emit the default profile's snapshot as
    // `usage_update` so older brokers / panels keep showing the top bar.
    // Remove once the v2 control panel has fully soaked.
    const defaultSnap = snapshots.find(s => s.profile === DEFAULT_PROFILE_NAME)
    if (defaultSnap) {
      const legacy = snapshotToLegacyUsageUpdate(defaultSnap)
      if (legacy) ws.send(JSON.stringify(legacy))
    }
  }

  // Poll immediately on connect, then on interval. Errors inside doPoll are
  // already caught per-profile -- the outer .catch is a safety net.
  void doPoll().catch(err => {
    diag('usage', `Cycle crashed: ${err instanceof Error ? err.message : String(err)}`)
  })
  usagePollTimer = setInterval(doPoll, USAGE_POLL_INTERVAL_MS)
}

function stopUsagePolling() {
  if (usagePollTimer) {
    clearInterval(usagePollTimer)
    usagePollTimer = null
  }
  profileBackoffUntil.clear()
}

/**
 * Build the broker-safe `sentinel_identify` payload from the live config. The
 * SAME shape is reused as the `applied` snapshot in a `sentinel_patch_config_ack`
 * so the broker refreshes its registry off one canonical builder. Carries
 * NAMES + display + routing only -- never configDir / env (Profile-Env Boundary).
 */
function buildSentinelIdentify(config: SentinelConfig, spawnRoot: string): SentinelIdentify {
  return {
    type: 'sentinel_identify',
    machineId: getMachineId(),
    hostname: osHostname(),
    spawnRoot,
    profiles: profileSummaries(config),
    defaultSelection: config.defaultSelection,
    pools: getPools(config),
    defaultPool: config.defaultPool,
    // Host-level capabilities. `shell` is the host-shell feature (plan 3.1) --
    // off when `--no-shell` / `CLAUDWERK_NO_SHELL=1`. The broker joins this onto
    // `ConversationSummary.shellCapable` per conversation (phase 3).
    features: { shell: shellFeatureEnabled },
  }
}

/**
 * Apply a broker-pushed `sentinel_patch_config` to the LIVE config in place +
 * persist it to disk, returning the ack to send back. Phase 8 of
 * `.claude/docs/plan-sentinel-profiles.md`.
 *
 * EVERYTHING IS A STRUCTURED MESSAGE + LOG EVERYTHING: every outcome (validate
 * reject, applied set of fields, IO failure + rollback) logs full context and
 * returns a typed `sentinel_patch_config_ack`.
 *
 * Flow: validate -> snapshot for rollback -> mutate in place -> atomic write.
 * On IO failure the in-memory mutation is rolled back from the snapshot so the
 * live config never diverges from disk.
 */
// fallow-ignore-next-line complexity
function handleSentinelPatchConfig(
  patch: SentinelPatchConfig,
  config: SentinelConfig,
  configPath: string,
  spawnRoot: string,
): SentinelPatchConfigAck {
  const patchId = typeof patch.patchId === 'string' ? patch.patchId : ''
  const profileCount = patch.profiles ? Object.keys(patch.profiles).length : 0
  log(
    `[patch-config] received patchId=${patchId} profiles=${profileCount}` +
      ` defaultSelection=${patch.defaultSelection ?? '-'} defaultPool=${patch.defaultPool ?? '-'} target=${configPath}`,
  )

  // 1. Validate against the LIVE config without touching state.
  const validation = validatePatch(config, patch)
  if (!validation.ok) {
    log(`[patch-config] REJECT patchId=${patchId} error=${validation.error} detail=${validation.detail}`)
    diag('patch-config', `reject ${validation.error}`, { patchId, detail: validation.detail })
    return { type: 'sentinel_patch_config_ack', patchId, ok: false, error: validation.error, detail: validation.detail }
  }

  // 2. Snapshot the in-memory state for rollback (deep-ish: per-profile fields
  //    we mutate + the two sentinel-wide fields).
  const snapshot = {
    defaultSelection: config.defaultSelection,
    defaultPool: config.defaultPool,
    profiles: Object.fromEntries(
      Object.entries(config.profiles).map(([name, p]) => [
        name,
        { weight: p.weight, pool: p.pool, label: p.label, color: p.color },
      ]),
    ),
  }

  // 3. Mutate in place.
  const touched = applyPatchInPlace(config, patch)

  // 4. Atomic write to disk, preserving unknown / future keys + the
  //    secret-bearing fields (configDir / env / spawnRoot) we never see here.
  try {
    const raw = readRawConfigObject(configPath)
    const next = spliceRawConfig(raw, patch)
    atomicWriteRawConfig(configPath, next)
  } catch (e) {
    // Roll back in-memory so the live config matches the (unchanged) disk.
    config.defaultSelection = snapshot.defaultSelection
    config.defaultPool = snapshot.defaultPool
    for (const [name, fields] of Object.entries(snapshot.profiles)) {
      const p = config.profiles[name]
      if (!p) continue
      p.weight = fields.weight
      p.pool = fields.pool
      p.label = fields.label
      p.color = fields.color
    }
    const detail = `atomic write to ${configPath} failed: ${(e as Error).message}`
    log(`[patch-config] IO_ERROR patchId=${patchId} ${detail} (rolled back in-memory)`)
    diag('patch-config', 'io_error (rolled back)', { patchId, detail })
    return { type: 'sentinel_patch_config_ack', patchId, ok: false, error: 'io_error', detail }
  }

  // 5. Success -- log every touched field, return fresh snapshot for the broker.
  config.sourcePath = configPath
  const changes = touched.map(t => `${t.scope}.${t.field} ${t.from}->${t.to}`).join(' ') || '(no-op)'
  log(`[patch-config] APPLIED patchId=${patchId} changes=[${changes}] persisted=${configPath}`)
  diag('patch-config', 'applied', { patchId, changes: touched })
  return { type: 'sentinel_patch_config_ack', patchId, ok: true, applied: buildSentinelIdentify(config, spawnRoot) }
}

function connect(
  url: string,
  secret: string,
  reviveScript: string,
  verbose: boolean,
  spawnRoot: string,
  noSpawn: boolean,
  config: SentinelConfig,
  configPath: string,
) {
  const wsUrl = secret ? `${url}?secret=${encodeURIComponent(secret)}` : url
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let shouldReconnect = true

  log(`Connecting to ${url}...`)

  const ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    log('Connected to broker')
    activeWs = ws
    // Identify as sentinel with machine fingerprint. Profile NAMES + display
    // travel here -- per the Profile-Env Boundary covenant, the configDir
    // and `profile.env` never leave the sentinel.
    ws.send(JSON.stringify(buildSentinelIdentify(config, spawnRoot)))

    // Report any dead PIDs from previous sentinel run
    reportDeadPids(ws)

    // Re-announce live host shells so they survive a broker restart. The PTYs
    // are FLOATING (sentinel-owned) -- this resync is the ONLY thing that tells
    // a freshly-restarted broker they still exist (plan-shell-resync.md).
    sendShellResync(url, secret)

    // Start per-profile usage polling. Emits one batched
    // `sentinel_usage_report` per cycle covering every configured profile,
    // plus a back-compat `usage_update` derived from the default profile
    // for one release. See `src/sentinel/usage-poller.ts`.
    startProfileUsagePolling(ws, verbose, config)

    // Start mirroring the Claude Code daemon roster (read-only native bg sessions).
    // Tag each polled job with the active profile NAME so the broker can set
    // `Conversation.resolvedProfile` on the ghost mirror -- the control panel
    // needs it to tint the badge. NAME only -- configDir/env stay sentinel-side
    // per the Profile-Env Boundary covenant.
    const activeProfile = profileNameForConfigDir(config, claudeConfigDir())
    startDaemonRosterWatch(ws, { log, diag, profile: activeProfile })

    // Start the CC daemon version watcher. Pings every 60s; on diff, emits a
    // `cc_version_changed` event. Sentinel id stamped from the auth-derived
    // value where present, otherwise from the stable machine id (legacy
    // shared-secret sentinels lack a snt_ id).
    ccVersionWatcher = createCcVersionWatcher({
      sentinelId: getMachineId(),
      ping: async () => {
        const sock = resolveControlSocket()
        if (!sock) return null
        try {
          const resp = await ping(sock)
          if (!resp.ok) return null
          const version = typeof resp.version === 'string' ? resp.version : null
          const proto = typeof resp.proto === 'number' ? resp.proto : null
          if (!version || proto === null) return null
          return { version, proto }
        } catch {
          return null
        }
      },
      loadLastSeen: loadCcVersionState,
      persistLastSeen: saveCcVersionState,
      emit: event => {
        log(
          `[cc-version] changed sentinel=${event.sentinelId} ` +
            `version ${event.fromVersion ?? '(first-seen)'} -> ${event.toVersion} ` +
            `proto ${event.fromProto ?? '(first-seen)'} -> ${event.toProto} ` +
            `at=${event.observedAt}`,
        )
        if (activeWs?.readyState === WebSocket.OPEN) {
          try {
            activeWs.send(JSON.stringify(event satisfies CcVersionChanged))
          } catch {}
        }
      },
      // Min-version safety net (sweep P1-3 / C4). The sentinel does not see
      // the broker's GlobalSettings.defaultTransport directly; the broker's
      // current default IS 'claude-daemon' (post Phase-3 migration), so we
      // always check the floor here. A dashboard that knows daemon is opted
      // OUT can suppress the banner client-side.
      isDaemonDefault: () => true,
      emitMinUnmet: event => {
        log(
          `[cc-version] MIN UNMET sentinel=${event.sentinelId} installed=${event.installedVersion}` +
            ` required=${event.requiredVersion} for=${event.requiredFor} at=${event.observedAt}`,
        )
        if (activeWs?.readyState === WebSocket.OPEN) {
          try {
            activeWs.send(JSON.stringify(event))
          } catch {}
        }
      },
      onError: err => diag('cc-version', `ping failed: ${err.message}`),
    })
    ccVersionWatcher.start()

    // Start heartbeat
    heartbeatTimer = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }))
      } catch {}
    }, HEARTBEAT_INTERVAL_MS)
  }

  ws.onmessage = async event => {
    try {
      const msg = JSON.parse(String(event.data)) as BrokerSentinelMessage | { type: string }

      switch (msg.type) {
        case 'ack':
          debug('Sentinel registered successfully', verbose)
          break

        case 'sentinel_reject':
          log(`Rejected: ${'reason' in msg ? msg.reason : 'unknown'}`)
          shouldReconnect = false
          ws.close()
          process.exit(1)
          break

        case 'quit':
          log(`Quit requested: ${'reason' in msg ? msg.reason : 'no reason'}`)
          shouldReconnect = false
          ws.close()
          process.exit(0)
          break

        case 'revive': {
          const reviveMsg = msg as ReviveConversation
          const parsedRevive = parseProjectUri(reviveMsg.project)
          const reviveCwd = parsedRevive.path
          const aht = reviveMsg.agentHostType || 'claude'

          // Resolve the sentinel profile. Revive always pins -- the broker
          // sends the RESOLVED profile NAME in `reviveMsg.profile` (read from
          // `Conversation.resolvedProfile`). Selection-mode tokens
          // (balanced/random) must NEVER reach revive; guard defensively.
          // Falls through to `default` when absent.
          let reviveProfileInput = reviveMsg.profile
          if (reviveProfileInput === 'balanced' || reviveProfileInput === 'random') {
            // Defensive: a buggy broker or test harness should NEVER trigger
            // a re-roll on revive. Log loud + drop the token to fall back to
            // default rather than pulling the rug on transcript discovery.
            log(
              `[revive] WARN selection-mode token "${reviveProfileInput}" arrived on revive for conv=${reviveMsg.conversationId.slice(0, 8)} -- treating as <absent>, NOT re-rolling`,
            )
            diag('revive', 'selection-mode token on revive (defensive fallback)', {
              conversationId: reviveMsg.conversationId.slice(0, 8),
              originalProfile: reviveProfileInput,
            })
            reviveProfileInput = undefined
          }
          let resolvedReviveProfile: ResolvedProfile
          try {
            resolvedReviveProfile = resolveProfile(config, reviveProfileInput)
          } catch (e) {
            const errMsg = `revive: profile resolution failed: ${(e as Error).message}`
            launchLog(reviveMsg.jobId, 'profile resolution failed', 'error', errMsg)
            log(errMsg)
            ws.send(
              JSON.stringify({
                type: 'revive_result',
                ccSessionId: reviveMsg.ccSessionId,
                conversationId: reviveMsg.conversationId,
                project: reviveMsg.project,
                jobId: reviveMsg.jobId,
                success: false,
                continued: false,
                error: errMsg,
              } satisfies ReviveResult),
            )
            break
          }
          log(
            `Reviving ccSession=${reviveMsg.ccSessionId.slice(0, 8)} conv=${reviveMsg.conversationId.slice(0, 8)} mode=${reviveMsg.mode || 'default'} headless=${reviveMsg.headless !== false} agentHostType=${aht}${reviveMsg.effort ? ` effort=${reviveMsg.effort}` : ''}${reviveMsg.model ? ` model=${reviveMsg.model}` : ''}${reviveMsg.maxBudgetUsd ? ` maxBudget=$${reviveMsg.maxBudgetUsd}` : ''}${reviveMsg.jobId ? ` job=${reviveMsg.jobId?.slice(0, 8)}` : ''} (${reviveCwd})`,
          )
          launchLog(reviveMsg.jobId, 'Sentinel received revive request', 'ok')

          // ─── ACP-host revive path (headless only) ────────────────────
          // OpenCode and other ACP agents are always headless. Route to
          // acp-host with a resumeSessionId so the agent can restore context.
          if (aht === 'acp') {
            const acpAgent = reviveMsg.acpAgent
            if (!acpAgent) {
              launchLog(reviveMsg.jobId, 'ACP revive rejected', 'error', 'Missing acpAgent field')
              ws.send(
                JSON.stringify({
                  type: 'revive_result',
                  ccSessionId: reviveMsg.ccSessionId,
                  conversationId: reviveMsg.conversationId,
                  project: reviveMsg.project,
                  jobId: reviveMsg.jobId,
                  success: false,
                  continued: false,
                  error: 'ACP revive missing acpAgent field',
                }),
              )
              break
            }
            const acpBin = findAcpHostBinary()
            if (!acpBin) {
              const err =
                'acp-host binary not found in PATH or known locations. Install with: bun install -g @claudewerk/acp-host'
              launchLog(reviveMsg.jobId, 'acp-host not found', 'error', err)
              ws.send(
                JSON.stringify({
                  type: 'revive_result',
                  ccSessionId: reviveMsg.ccSessionId,
                  conversationId: reviveMsg.conversationId,
                  project: reviveMsg.project,
                  jobId: reviveMsg.jobId,
                  success: false,
                  continued: false,
                  error: err,
                }),
              )
              break
            }
            if (!existsSync(reviveCwd)) {
              const err = `Directory not found: ${reviveCwd}`
              launchLog(reviveMsg.jobId, 'ACP revive directory missing', 'error', err)
              ws.send(
                JSON.stringify({
                  type: 'revive_result',
                  ccSessionId: reviveMsg.ccSessionId,
                  conversationId: reviveMsg.conversationId,
                  project: reviveMsg.project,
                  jobId: reviveMsg.jobId,
                  success: false,
                  continued: false,
                  error: err,
                }),
              )
              break
            }
            const acpRes = spawnAcpHostDirect({
              bin: acpBin,
              cwd: reviveCwd,
              conversationId: reviveMsg.conversationId,
              secret,
              jobId: reviveMsg.jobId,
              acpAgent,
              model: reviveMsg.openCodeModel || reviveMsg.model,
              conversationName: reviveMsg.conversationName,
              env: reviveMsg.env,
              toolPermission: reviveMsg.toolPermission,
              resumeSessionId: reviveMsg.ccSessionId,
            })
            ws.send(
              JSON.stringify({
                type: 'revive_result',
                ccSessionId: reviveMsg.ccSessionId,
                conversationId: reviveMsg.conversationId,
                project: reviveMsg.project,
                jobId: reviveMsg.jobId,
                success: acpRes.success,
                continued: true,
                error: acpRes.error,
                // Echo the resolved profile NAME so the broker can refresh a
                // re-targeted revive (incl. clearing back to 'default').
                resolvedProfile: resolvedReviveProfile.name,
              }),
            )
            if (acpRes.success) {
              bindConversationToProfile(reviveMsg.conversationId, resolvedReviveProfile.name)
              launchLog(reviveMsg.jobId, 'Waiting for ACP conversation to connect', 'info')
            } else {
              log(`ACP revive failed: ${acpRes.error}`)
            }
            break
          }

          // ─── opencode-host revive path (headless only, legacy NDJSON) ─
          if (aht === 'opencode') {
            const ocBin = findOpenCodeHostBinary()
            if (!ocBin) {
              const err =
                'opencode-host binary not found in PATH or known locations. Install with: bun install -g @claudewerk/opencode-host'
              launchLog(reviveMsg.jobId, 'opencode-host not found', 'error', err)
              ws.send(
                JSON.stringify({
                  type: 'revive_result',
                  ccSessionId: reviveMsg.ccSessionId,
                  conversationId: reviveMsg.conversationId,
                  project: reviveMsg.project,
                  jobId: reviveMsg.jobId,
                  success: false,
                  continued: false,
                  error: err,
                }),
              )
              break
            }
            if (!existsSync(reviveCwd)) {
              const err = `Directory not found: ${reviveCwd}`
              launchLog(reviveMsg.jobId, 'opencode-host revive directory missing', 'error', err)
              ws.send(
                JSON.stringify({
                  type: 'revive_result',
                  ccSessionId: reviveMsg.ccSessionId,
                  conversationId: reviveMsg.conversationId,
                  project: reviveMsg.project,
                  jobId: reviveMsg.jobId,
                  success: false,
                  continued: false,
                  error: err,
                }),
              )
              break
            }
            const ocRes = spawnOpenCodeHostDirect({
              bin: ocBin,
              cwd: reviveCwd,
              conversationId: reviveMsg.conversationId,
              secret,
              jobId: reviveMsg.jobId,
              model: reviveMsg.openCodeModel || reviveMsg.model,
              conversationName: reviveMsg.conversationName,
              env: reviveMsg.env,
              toolPermission: reviveMsg.toolPermission,
            })
            ws.send(
              JSON.stringify({
                type: 'revive_result',
                ccSessionId: reviveMsg.ccSessionId,
                conversationId: reviveMsg.conversationId,
                project: reviveMsg.project,
                jobId: reviveMsg.jobId,
                success: ocRes.success,
                continued: false,
                error: ocRes.error,
                // Echo the resolved profile NAME so the broker can refresh a
                // re-targeted revive (incl. clearing back to 'default').
                resolvedProfile: resolvedReviveProfile.name,
              }),
            )
            if (ocRes.success) {
              bindConversationToProfile(reviveMsg.conversationId, resolvedReviveProfile.name)
              launchLog(reviveMsg.jobId, 'Waiting for OpenCode conversation to connect', 'info')
            } else {
              log(`OpenCode revive failed: ${ocRes.error}`)
            }
            break
          }

          // ─── Default: rclaude (claude) revive path ──────────────────
          const result = await reviveConversation(
            reviveMsg.ccSessionId,
            reviveCwd,
            reviveMsg.conversationId,
            reviveScript,
            secret,
            verbose,
            reviveMsg.mode,
            reviveMsg.headless !== false,
            reviveMsg.effort,
            reviveMsg.model,
            reviveMsg.conversationName,
            reviveMsg.autocompactPct,
            reviveMsg.maxBudgetUsd,
            reviveMsg.jobId,
            reviveMsg.adHocWorktree,
            reviveMsg.env,
            reviveMsg.agent,
            resolvedReviveProfile,
            reviveMsg.advisor,
          )
          // Strip sentinel-internal tmuxPaneId before sending over WS. Echo the
          // resolved profile NAME (not configDir / env -- Profile-Env Boundary).
          // ALWAYS echo, including the literal 'default': a revive can re-target
          // the profile (terminate on a named profile, revive on default), and
          // the broker must be able to CLEAR conv.resolvedProfile back to
          // default. A non-default-only echo leaves the broker unable to tell
          // "revived to default" from "no info", so the stale name would stick.
          result.resolvedProfile = resolvedReviveProfile.name
          const { tmuxPaneId, ...reviveResult } = result
          ws.send(JSON.stringify(reviveResult))
          if (result.success) {
            bindConversationToProfile(reviveMsg.conversationId, resolvedReviveProfile.name)
            launchLog(reviveMsg.jobId, 'Waiting for conversation to connect', 'info')
            if (result.tmuxSession) {
              log(
                `Revived in tmux session "${result.tmuxSession}" pane=${tmuxPaneId || 'n/a'} (continued: ${result.continued})`,
              )
            } else {
              log(`Revived headless (continued: ${result.continued})`)
            }

            // Async tmux health check: verify the pane is still alive after 5s.
            // Catches cases where rclaude crashes before it can connect WS
            // (binary not found, shell PATH broken, early bootstrap failure).
            // Pane IDs (%NNN) are globally unique and stable regardless of
            // session/window renames.
            if (tmuxPaneId) {
              const paneId = tmuxPaneId
              const wid = reviveMsg.conversationId
              const jid = reviveMsg.jobId
              setTimeout(() => {
                const check = Bun.spawnSync([TMUX_BIN, 'list-panes', '-t', paneId], {
                  stdout: 'pipe',
                  stderr: 'pipe',
                })
                if (check.exitCode !== 0) {
                  log(`tmux pane ${paneId} died within 5s of spawn (conv=${wid.slice(0, 8)})`)
                  launchLog(jid, 'tmux pane died', 'error', 'rclaude crashed during startup')
                  const msg: SpawnFailed = {
                    type: 'spawn_failed',
                    conversationId: wid,
                    project: cwdToProjectUri(reviveCwd),
                    error: 'rclaude process died within 5s of tmux launch - check shell environment, PATH, and hooks',
                  }
                  try {
                    ws.send(JSON.stringify(msg))
                  } catch {}
                } else {
                  debug(`tmux health check OK: pane ${paneId} alive (conv=${wid.slice(0, 8)})`, verbose)
                }
              }, 5000)
            }
          } else {
            log(`Revive failed: ${result.error}`)
          }
          break
        }

        case 'spawn': {
          const spawnMsg = msg as SpawnConversation
          if (noSpawn) {
            launchLog(spawnMsg.jobId, 'Spawning disabled', 'error', '--no-spawn flag is set')
            ws.send(
              JSON.stringify({
                type: 'spawn_result',
                requestId: spawnMsg.requestId,
                jobId: spawnMsg.jobId,
                success: false,
                error: 'Spawning disabled (--no-spawn)',
              }),
            )
            break
          }

          // Resolve the sentinel profile. A literal name short-circuits
          // (fixed); `balanced` / `random` mode tokens run the picker over
          // the requested pool (or `config.defaultPool` when absent);
          // absent / `default` consults config.defaultSelection. Unknown
          // literal names abort with a structured spawn failure.
          let resolvedSpawnProfile: ResolvedProfile
          let spawnPicker: 'fixed' | 'balanced' | 'random' | 'default' = 'default'
          let spawnPickerCandidates: string[] = []
          let spawnPickerPool = ''
          let spawnPickerReason = ''
          let spawnPickerLeaned: string[] = []
          try {
            const pickerUsage = buildPickerUsageSource(config)
            spawnPickerLeaned = pickerUsage.substituted
            const picked = pickProfile(config, {
              input: spawnMsg.profile,
              pool: typeof spawnMsg.pool === 'string' ? spawnMsg.pool : undefined,
              liveLoad: liveLoadForProfile,
              usage: pickerUsage.usage,
            })
            resolvedSpawnProfile = picked.profile
            spawnPicker = picked.picker
            spawnPickerCandidates = picked.candidates
            spawnPickerPool = picked.requestedPool
            spawnPickerReason = picked.reason
          } catch (e) {
            const errMsg = `spawn: profile resolution failed: ${(e as Error).message}`
            launchLog(spawnMsg.jobId, 'profile resolution failed', 'error', errMsg)
            log(errMsg)
            ws.send(
              JSON.stringify({
                type: 'spawn_result',
                requestId: spawnMsg.requestId,
                jobId: spawnMsg.jobId,
                success: false,
                error: errMsg,
                conversationId: spawnMsg.conversationId,
              } satisfies SpawnResult),
            )
            break
          }
          // LOG EVERYTHING covenant: surface the picker decision so a future
          // engineer can reconstruct why a given conversation landed on a
          // given profile from sentinel logs + diag alone.
          log(
            `[picker] mode=${spawnMsg.profile ?? '<absent>'} pool=${spawnMsg.pool ?? '<absent>'} -> picked=${resolvedSpawnProfile.name} via=${spawnPicker} reason=${spawnPickerReason} requestedPool=${spawnPickerPool || '<n/a>'} candidates=[${spawnPickerCandidates.join(',')}] leaned=[${spawnPickerLeaned.join(',')}] conv=${spawnMsg.conversationId.slice(0, 8)}`,
          )
          diag('spawn', 'profile picked', {
            input: spawnMsg.profile ?? null,
            requestedPoolInput: spawnMsg.pool ?? null,
            picker: spawnPicker,
            picked: resolvedSpawnProfile.name,
            reason: spawnPickerReason,
            requestedPool: spawnPickerPool || null,
            candidates: spawnPickerCandidates,
            // Profiles whose usage probe was unreadable (401/429) and were leaned
            // toward via the optimistic recently-reset assumption -- see
            // `buildPickerUsageSource` / `resolveBalancedHeadrooms`.
            leanedUnmeasurable: spawnPickerLeaned,
            conversationId: spawnMsg.conversationId.slice(0, 8),
            liveLoadSnapshot: Object.fromEntries(profileLoad),
          })
          const spawnCwdRaw = spawnMsg.cwd
          // Per-profile spawnRoot overrides the sentinel-wide one when set
          // (e.g. a `work` profile that defaults to `~/work`). Profile env
          // never reaches the broker; the resolved cwd does.
          const effectiveSpawnRoot = resolvedSpawnProfile.spawnRoot ?? spawnRoot
          const expandedCwd = expandPath(spawnCwdRaw, effectiveSpawnRoot)
          // The resolved profile NAME is reported back to the broker as
          // `spawn_result.resolvedProfile` (sibling field, NOT in the URI).
          // The URI is pure location -- broker pins the profile on the
          // conversation record itself.
          const resolvedProject = cwdToProjectUri(expandedCwd, 'claude')
          launchLog(spawnMsg.jobId, 'Sentinel received spawn request', 'ok', expandedCwd.split('/').pop())
          diag('spawn', 'Spawn request received', {
            requestId: spawnMsg.requestId,
            cwd: spawnMsg.cwd,
            resolvedProject,
            expandedCwd,
            conversationId: spawnMsg.conversationId,
            mkdir: spawnMsg.mkdir,
            mode: spawnMsg.mode,
            headless: spawnMsg.headless,
            resumeId: spawnMsg.resumeId,
            agentHostType: spawnMsg.agentHostType,
          })

          // ─── inline settings materialization ─────────────────────
          // The broker may hand us an opaque `settingsInline` object (unattended
          // allowlist + deny-floor -- plan-quest-engine §6a). The broker never
          // writes host files (FS boundary); the SENTINEL materializes it here
          // to a secure temp file, then feeds it through the settingsPath seam
          // for whichever backend branch runs below. Materialized inline wins
          // over any explicit settingsPath.
          let materializedSettingsPath: string | undefined
          if (spawnMsg.settingsInline) {
            try {
              materializedSettingsPath = secureTmpPath(`rclaude-settings-inline-${spawnMsg.conversationId}.json`)
              await writeSecureFile(materializedSettingsPath, JSON.stringify(spawnMsg.settingsInline, null, 2))
              launchLog(spawnMsg.jobId, 'Inline settings materialized', 'ok', materializedSettingsPath.split('/').pop())
            } catch (e: unknown) {
              materializedSettingsPath = undefined
              launchLog(spawnMsg.jobId, 'Inline settings materialization failed', 'error', (e as Error).message)
            }
          }
          const effectiveSettingsPath = materializedSettingsPath ?? spawnMsg.settingsPath

          // ─── acp-host spawn path ─────────────────────────────────
          // Routed when the broker tags a spawn with agentHostType: 'acp'.
          // The recipe (acp-recipes.ts, keyed by spawnMsg.acpAgent) supplies
          // the underlying agent's spawn cmd, permission preamble, etc.
          if (spawnMsg.agentHostType === 'acp') {
            const acpAgent = (spawnMsg as { acpAgent?: string }).acpAgent
            if (!acpAgent) {
              const err = 'ACP spawn missing acpAgent field'
              launchLog(spawnMsg.jobId, 'ACP spawn rejected', 'error', err)
              ws.send(
                JSON.stringify({
                  type: 'spawn_result',
                  requestId: spawnMsg.requestId,
                  jobId: spawnMsg.jobId,
                  success: false,
                  error: err,
                  project: resolvedProject,
                  conversationId: spawnMsg.conversationId,
                } satisfies SpawnResult),
              )
              break
            }
            const acpBin = findAcpHostBinary()
            if (!acpBin) {
              const err =
                'acp-host binary not found in PATH or known locations. Install with: bun install -g @claudewerk/acp-host'
              launchLog(spawnMsg.jobId, 'acp-host not found', 'error', err)
              ws.send(
                JSON.stringify({
                  type: 'spawn_result',
                  requestId: spawnMsg.requestId,
                  jobId: spawnMsg.jobId,
                  success: false,
                  error: err,
                  project: resolvedProject,
                  conversationId: spawnMsg.conversationId,
                } satisfies SpawnResult),
              )
              break
            }
            // Validate cwd same way as the rclaude path.
            if (!existsSync(expandedCwd)) {
              if (spawnMsg.mkdir) {
                try {
                  mkdirSync(expandedCwd, { recursive: true })
                } catch (e: unknown) {
                  const err = `Failed to create directory: ${(e as Error).message}`
                  ws.send(
                    JSON.stringify({
                      type: 'spawn_result',
                      requestId: spawnMsg.requestId,
                      jobId: spawnMsg.jobId,
                      success: false,
                      error: err,
                    }),
                  )
                  break
                }
              } else {
                ws.send(
                  JSON.stringify({
                    type: 'spawn_result',
                    requestId: spawnMsg.requestId,
                    jobId: spawnMsg.jobId,
                    success: false,
                    error: `Directory not found: ${expandedCwd}`,
                  }),
                )
                break
              }
            }
            if (!isSpawnApproved(expandedCwd)) {
              const err = `Spawn not allowed: no .rclaude-spawn marker at or above ${expandedCwd}`
              launchLog(spawnMsg.jobId, 'spawn not approved', 'error', err)
              ws.send(
                JSON.stringify({
                  type: 'spawn_result',
                  requestId: spawnMsg.requestId,
                  jobId: spawnMsg.jobId,
                  success: false,
                  error: err,
                  project: resolvedProject,
                  conversationId: spawnMsg.conversationId,
                } satisfies SpawnResult),
              )
              break
            }
            let promptFile: string | undefined
            if (spawnMsg.prompt) {
              promptFile = secureTmpPath(`acp-prompt-${spawnMsg.conversationId}`)
              try {
                await writeSecureFile(promptFile, spawnMsg.prompt)
              } catch {
                promptFile = undefined
              }
            }
            const acpRes = spawnAcpHostDirect({
              bin: acpBin,
              cwd: expandedCwd,
              conversationId: spawnMsg.conversationId,
              secret,
              jobId: spawnMsg.jobId,
              acpAgent,
              model: spawnMsg.openCodeModel || spawnMsg.model,
              conversationName: spawnMsg.conversationName,
              conversationDescription: spawnMsg.conversationDescription,
              promptFile,
              env: spawnMsg.env,
              toolPermission: spawnMsg.toolPermission,
              resumeSessionId: spawnMsg.resumeId,
            })
            ws.send(
              JSON.stringify({
                type: 'spawn_result',
                requestId: spawnMsg.requestId,
                jobId: spawnMsg.jobId,
                success: acpRes.success,
                error: acpRes.error,
                project: resolvedProject,
                conversationId: spawnMsg.conversationId,
              } satisfies SpawnResult),
            )
            if (acpRes.success) {
              bindConversationToProfile(spawnMsg.conversationId, resolvedSpawnProfile.name)
              launchLog(spawnMsg.jobId, 'Waiting for conversation to connect', 'info')
            }
            break
          }

          // ─── opencode-host spawn path (legacy NDJSON) ────────────
          // Routed when the broker-side opencode backend tags the spawn
          // message with agentHostType: 'opencode'. We launch the
          // opencode-host binary instead of rclaude and skip the rclaude-
          // specific arg/env machinery (model/effort/permissionMode/etc).
          // The default OpenCode path is now ACP (above); this branch
          // remains as a fallback for callers that pin agentHostType to
          // 'opencode' explicitly.
          if (spawnMsg.agentHostType === 'opencode') {
            const ocBin = findOpenCodeHostBinary()
            if (!ocBin) {
              const err =
                'opencode-host binary not found in PATH or known locations. Install with: bun install -g @claudewerk/opencode-host'
              launchLog(spawnMsg.jobId, 'opencode-host not found', 'error', err)
              const failResp: SpawnResult = {
                type: 'spawn_result',
                requestId: spawnMsg.requestId,
                jobId: spawnMsg.jobId,
                success: false,
                error: err,
                project: resolvedProject,
                conversationId: spawnMsg.conversationId,
              }
              ws.send(JSON.stringify(failResp))
              break
            }
            // Validate cwd same way as the rclaude path (spawn-approval marker).
            if (!existsSync(expandedCwd)) {
              if (spawnMsg.mkdir) {
                try {
                  mkdirSync(expandedCwd, { recursive: true })
                } catch (e: unknown) {
                  const err = `Failed to create directory: ${(e as Error).message}`
                  ws.send(
                    JSON.stringify({
                      type: 'spawn_result',
                      requestId: spawnMsg.requestId,
                      jobId: spawnMsg.jobId,
                      success: false,
                      error: err,
                    }),
                  )
                  break
                }
              } else {
                ws.send(
                  JSON.stringify({
                    type: 'spawn_result',
                    requestId: spawnMsg.requestId,
                    jobId: spawnMsg.jobId,
                    success: false,
                    error: `Directory not found: ${expandedCwd}`,
                  }),
                )
                break
              }
            }
            if (!isSpawnApproved(expandedCwd)) {
              const err = `Spawn not allowed: no .rclaude-spawn marker at or above ${expandedCwd}`
              const failResp: SpawnResult = {
                type: 'spawn_result',
                requestId: spawnMsg.requestId,
                jobId: spawnMsg.jobId,
                success: false,
                error: err,
                project: resolvedProject,
                conversationId: spawnMsg.conversationId,
              }
              ws.send(JSON.stringify(failResp))
              break
            }
            // Optional initial prompt -- write to file (avoids shell escaping).
            let promptFile: string | undefined
            if (spawnMsg.prompt) {
              promptFile = secureTmpPath(`opencode-prompt-${spawnMsg.conversationId}`)
              try {
                await writeSecureFile(promptFile, spawnMsg.prompt)
              } catch {
                promptFile = undefined
              }
            }
            const ocRes = spawnOpenCodeHostDirect({
              bin: ocBin,
              cwd: expandedCwd,
              conversationId: spawnMsg.conversationId,
              secret,
              jobId: spawnMsg.jobId,
              model: spawnMsg.openCodeModel || spawnMsg.model,
              conversationName: spawnMsg.conversationName,
              conversationDescription: spawnMsg.conversationDescription,
              promptFile,
              env: spawnMsg.env,
              toolPermission: spawnMsg.toolPermission,
            })
            const ocResp: SpawnResult = {
              type: 'spawn_result',
              requestId: spawnMsg.requestId,
              jobId: spawnMsg.jobId,
              success: ocRes.success,
              error: ocRes.error,
              project: resolvedProject,
              conversationId: spawnMsg.conversationId,
            }
            ws.send(JSON.stringify(ocResp))
            if (ocRes.success) {
              bindConversationToProfile(spawnMsg.conversationId, resolvedSpawnProfile.name)
              launchLog(spawnMsg.jobId, 'Waiting for conversation to connect', 'info')
            }
            break
          }

          // ─── daemon-host spawn path ──────────────────────────────
          // Routed when the broker's daemon backend tags a spawn with
          // agentHostType: 'daemon'. The sentinel dispatches a `claude --bg`
          // worker, captures its 8-hex short id, then launches bin/daemon-host
          // which attaches to that worker's PTY over the daemon control socket.
          if (spawnMsg.agentHostType === 'daemon') {
            const sendDaemonFail = (error: string): void => {
              launchLog(spawnMsg.jobId, 'daemon spawn rejected', 'error', error)
              ws.send(
                JSON.stringify({
                  type: 'spawn_result',
                  requestId: spawnMsg.requestId,
                  jobId: spawnMsg.jobId,
                  success: false,
                  error,
                  project: resolvedProject,
                  conversationId: spawnMsg.conversationId,
                } satisfies SpawnResult),
              )
            }

            const daemonBin = findDaemonHostBinary()
            if (!daemonBin) {
              sendDaemonFail(
                'daemon-host binary not found in PATH or known locations. Install with: bun install -g @claudewerk/daemon-host',
              )
              break
            }

            // Transport reframe (Phase 6): the daemon launch inputs ride in the
            // opaque `transportMeta` bag (normalized broker-side) -- there are no
            // flat `daemon*` fields on the spawn message anymore. src/sentinel is
            // a backend dispatch path, allowed to read transportMeta.
            const daemonMeta = (spawnMsg.transportMeta ?? {}) as Record<string, unknown>
            const daemonMetaStr = (key: string): string | undefined =>
              typeof daemonMeta[key] === 'string' ? (daemonMeta[key] as string) : undefined
            // NEW: dispatch a fresh worker. RESUME: dispatch --resume a forked
            // worker. ATTACH: attach to an already-running roster worker (no
            // dispatch). Default 'new' when the mode key is absent/garbage.
            const metaMode = daemonMetaStr('mode')
            const daemonMode: DaemonLaunchMode = metaMode === 'resume' || metaMode === 'attach' ? metaMode : 'new'
            const daemonResumeSessionId = daemonMetaStr('resumeSessionId')
            const daemonAttachShort = daemonMetaStr('attachShort')
            // A materialized inline-settings file (unattended allowlist + deny-floor)
            // wins over the transportMeta path so the daemon `--settings` carries it.
            const daemonSettingsPath = materializedSettingsPath ?? daemonMetaStr('settingsPath')
            const daemonMcpConfigPath = daemonMetaStr('mcpConfigPath')
            const daemonAppendSystemPrompt = daemonMetaStr('appendSystemPrompt')

            // Mode-specific required fields. NEW needs nothing -- promptless NEW
            // dispatch is supported (Phase 4 socket dispatch P1 proved
            // `launch.args:[]` boots an idle worker that takes its first turn via
            // a later `reply`). RESUME needs the session to fork from; ATTACH
            // needs the roster short to attach to.
            if (daemonMode === 'resume' && !daemonResumeSessionId?.trim()) {
              sendDaemonFail('claude-daemon spawn (resume mode) requires transportMeta.resumeSessionId')
              break
            }
            if (daemonMode === 'attach' && !daemonAttachShort?.trim()) {
              sendDaemonFail('claude-daemon spawn (attach mode) requires transportMeta.attachShort')
              break
            }

            // Validate cwd (create on mkdir) + spawn-approval marker -- same
            // gate as the rclaude / opencode / acp paths. Applies to all three
            // modes: the daemon-host needs a real cwd for the transcript slug.
            if (!existsSync(expandedCwd)) {
              if (spawnMsg.mkdir) {
                try {
                  mkdirSync(expandedCwd, { recursive: true })
                } catch (e: unknown) {
                  sendDaemonFail(`Failed to create directory: ${(e as Error).message}`)
                  break
                }
              } else {
                sendDaemonFail(`Directory not found: ${expandedCwd}`)
                break
              }
            }
            if (!isSpawnApproved(expandedCwd)) {
              sendDaemonFail(`Spawn not allowed: no .rclaude-spawn marker at or above ${expandedCwd}`)
              break
            }

            // Resolve the worker short id. NEW/RESUME dispatch a `claude --bg`
            // worker and capture its fresh short; ATTACH takes the short
            // straight from the roster-sourced spawn request after probing the
            // daemon `has` op to confirm the worker is present.
            let daemonShort: string
            // Host MCP endpoint for the daemon-host's local /mcp server. Set on
            // NEW/RESUME (we dispatch the worker + write its --mcp-config);
            // stays undefined for ATTACH (the worker was launched elsewhere).
            let hostMcpEndpoint: string | undefined
            if (daemonMode === 'attach') {
              // daemonAttachShort is validated non-empty above.
              const attachShort = daemonAttachShort as string
              // Profile-aware socket routing -- pick the daemon under the
              // resolved profile's CLAUDE_CONFIG_DIR (the work-profile worker
              // lives under a different daemon than the default-profile one).
              const controlSock = resolveControlSocket(socketEnvForProfile(resolvedSpawnProfile))
              if (!controlSock) {
                const profileLabel = resolvedSpawnProfile?.name ? ` (profile=${resolvedSpawnProfile.name})` : ''
                sendDaemonFail(
                  `daemon attach: no Claude Code daemon control socket reachable${profileLabel} -- the daemon may have idle-exited`,
                )
                break
              }
              let verdict: { ok: boolean; error?: string }
              let probeResp: Awaited<ReturnType<typeof has>> | null = null
              try {
                probeResp = await has(controlSock, attachShort)
                verdict = evaluateAttachPresence(probeResp, attachShort)
              } catch (e: unknown) {
                verdict = { ok: false, error: `daemon attach: has() probe failed: ${(e as Error).message}` }
              }
              // The probe is a discriminated DaemonResponse (DaemonOk vs DaemonErr).
              // Read alive/present via bracket access -- only present on the ok branch.
              const probeOk = probeResp?.ok === true
              const probeAlive = probeOk ? (probeResp as Record<string, unknown>).alive : undefined
              const probePresent = probeOk ? (probeResp as Record<string, unknown>).present : undefined
              const probeCode = probeResp && probeResp.ok === false ? probeResp.code : undefined
              if (!verdict.ok) {
                log(
                  `[daemon-attach] verify FAIL conv=${spawnMsg.conversationId.slice(0, 8)} short=${attachShort} ` +
                    `probeOk=${probeOk} alive=${probeAlive ?? '-'} present=${probePresent ?? '-'} ` +
                    `code=${probeCode ?? '-'} -- ${verdict.error}`,
                )
                sendDaemonFail(verdict.error ?? `daemon attach: worker ${attachShort} unavailable`)
                break
              }
              daemonShort = attachShort
              launchLog(
                spawnMsg.jobId,
                'daemon attach target verified',
                'ok',
                `conv=${spawnMsg.conversationId.slice(0, 8)} short=${daemonShort} ` +
                  `alive=${probeAlive ?? '-'} present=${probePresent ?? '-'}`,
              )
            } else {
              // NEW / RESUME -- validate config paths exist, then dispatch.
              const pathCheck = validateDaemonConfigPaths(
                { settingsPath: daemonSettingsPath, mcpConfigPath: daemonMcpConfigPath },
                existsSync,
              )
              if (!pathCheck.ok) {
                sendDaemonFail(pathCheck.error ?? 'daemon spawn: config path validation failed')
                break
              }
              // Deterministic host MCP endpoint: write the worker's --mcp-config
              // up front (the daemon dispatches `claude` before the host binds
              // its server) + hand the same endpoint to the daemon-host below.
              const hostMcp = writeDaemonMcpConfig(spawnMsg.conversationId)
              hostMcpEndpoint = hostMcp.endpoint
              emitDaemonLaunchEvent({
                conversationId: spawnMsg.conversationId,
                step: 'dispatch_requested',
                daemonMode,
                detail: `cwd=${expandedCwd} model=${spawnMsg.model ?? 'default'}`,
                raw: {
                  cwd: expandedCwd,
                  model: spawnMsg.model,
                  resumeSessionId: daemonResumeSessionId,
                  hasSettings: !!daemonSettingsPath,
                  hasMcpConfig: !!daemonMcpConfigPath,
                  hasHostMcp: true,
                  hasAppendSystemPrompt: !!daemonAppendSystemPrompt,
                  profileName: resolvedSpawnProfile?.name,
                },
              })
              const dispatched = await dispatchDaemonWorker({
                cwd: expandedCwd,
                mode: daemonMode,
                prompt: spawnMsg.prompt,
                resumeSessionId: daemonResumeSessionId,
                model: spawnMsg.model,
                name: spawnMsg.conversationName,
                profile: resolvedSpawnProfile,
                settingsPath: daemonSettingsPath,
                mcpConfigPath: daemonMcpConfigPath,
                hostMcpConfigPath: hostMcp.configPath,
                appendSystemPrompt: daemonAppendSystemPrompt,
                env: spawnMsg.env,
                jobId: spawnMsg.jobId,
              })
              if (!dispatched.short) {
                sendDaemonFail(`claude --bg returned no job id -- ${dispatched.output.slice(0, 300) || 'no output'}`)
                break
              }
              daemonShort = dispatched.short
              launchLog(spawnMsg.jobId, 'daemon worker dispatched', 'ok', `short=${daemonShort} mode=${daemonMode}`)
              emitDaemonLaunchEvent({
                conversationId: spawnMsg.conversationId,
                step: 'worker_dispatched',
                daemonMode,
                short: daemonShort,
                detail: dispatched.output,
              })
              // Unify daemon identity: register this session -> our conversationId in
              // the sentinel daemon-map so the roster mirror REUSES it instead of
              // minting a duplicate ghost row for the same worker (the split-identity
              // bug). NEW only -- the minted sessionId becomes the worker's ccSessionId
              // for a NEW dispatch; RESUME forks to a fresh daemon-assigned id we
              // cannot pre-register (the observer binds it later).
              if (daemonMode === 'new') {
                // `allowClobber: true` -- a `mode=new` dispatch is authoritative.
                // If the daemon silently reused a still-alive worker (or our
                // minted sessionId collided with an existing mapping), the new
                // claudewerk conversationId wins; the previous owner becomes a
                // roster-orphan and is reconciled by the broker. See the
                // 2026-05-27 worker-reuse incident -- without clobber the new
                // conversation never got its `daemonShort` stamped because the
                // roster mirror kept keying the worker under the stale old id.
                const registered = registerDaemonSession(
                  dispatched.sessionId,
                  spawnMsg.conversationId,
                  resolvedSpawnProfile.configDir,
                  { allowClobber: true },
                )
                launchLog(
                  spawnMsg.jobId,
                  'daemon session registered in roster map',
                  'info',
                  `session=${dispatched.sessionId.slice(0, 12)} conv=${spawnMsg.conversationId.slice(0, 8)} registered=${registered}`,
                )
              }
            }

            const daemonRes = spawnDaemonHostDirect({
              bin: daemonBin,
              cwd: expandedCwd,
              conversationId: spawnMsg.conversationId,
              daemonShort,
              mode: daemonMode,
              resumeSessionId: daemonResumeSessionId,
              secret,
              jobId: spawnMsg.jobId,
              conversationName: spawnMsg.conversationName,
              conversationDescription: spawnMsg.conversationDescription,
              env: spawnMsg.env,
              mcpEndpoint: hostMcpEndpoint,
              profile: resolvedSpawnProfile,
            })
            ws.send(
              JSON.stringify({
                type: 'spawn_result',
                requestId: spawnMsg.requestId,
                jobId: spawnMsg.jobId,
                success: daemonRes.success,
                error: daemonRes.error,
                project: resolvedProject,
                conversationId: spawnMsg.conversationId,
              } satisfies SpawnResult),
            )
            if (daemonRes.success) {
              bindConversationToProfile(spawnMsg.conversationId, resolvedSpawnProfile.name)
              launchLog(spawnMsg.jobId, 'Waiting for conversation to connect', 'info')
            }
            break
          }

          const spawnRes = await spawnConversation(
            expandedCwd,
            spawnMsg.conversationId,
            reviveScript,
            secret,
            verbose,
            spawnMsg.mkdir,
            spawnMsg.mode,
            spawnMsg.resumeId,
            spawnMsg.headless !== false, // default true
            spawnMsg.effort,
            spawnMsg.model,
            spawnMsg.bare || false,
            spawnMsg.repl || false,
            spawnMsg.conversationName,
            spawnMsg.conversationDescription,
            spawnMsg.permissionMode,
            spawnMsg.autocompactPct,
            spawnMsg.maxBudgetUsd,
            spawnMsg.prompt,
            spawnMsg.adHoc || false,
            spawnMsg.adHocTaskId,
            spawnMsg.worktree,
            spawnMsg.jobId,
            spawnMsg.leaveRunning || false,
            spawnMsg.includePartialMessages,
            spawnMsg.env,
            spawnMsg.agent,
            spawnMsg.appendSystemPrompt,
            resolvedSpawnProfile,
            effectiveSettingsPath,
            spawnMsg.mcpConfigPath,
            spawnMsg.advisor,
          )
          const response: SpawnResult = {
            type: 'spawn_result',
            requestId: spawnMsg.requestId,
            jobId: spawnMsg.jobId,
            success: spawnRes.success,
            error: spawnRes.error,
            project: resolvedProject,
            tmuxSession: spawnRes.tmuxSession,
            conversationId: spawnMsg.conversationId,
          }
          // Echo the resolved profile NAME (not configDir / env -- Profile-Env
          // Boundary). Default profile is implicit; omit so existing clients
          // unaware of `resolvedProfile` stay unaffected.
          if (resolvedSpawnProfile.name !== DEFAULT_PROFILE_NAME) {
            response.resolvedProfile = resolvedSpawnProfile.name
          }
          ws.send(JSON.stringify(response))
          if (spawnRes.success) {
            bindConversationToProfile(spawnMsg.conversationId, resolvedSpawnProfile.name)
            launchLog(spawnMsg.jobId, 'Waiting for conversation to connect', 'info')

            // Async tmux pane health check (same as revive path)
            if (spawnRes.tmuxPaneId) {
              const paneId = spawnRes.tmuxPaneId
              const wid = spawnMsg.conversationId
              const jid = spawnMsg.jobId
              const spawnProject = spawnMsg.project
              setTimeout(() => {
                const check = Bun.spawnSync([TMUX_BIN, 'list-panes', '-t', paneId], {
                  stdout: 'pipe',
                  stderr: 'pipe',
                })
                if (check.exitCode !== 0) {
                  log(`tmux pane ${paneId} died within 5s of spawn (conv=${wid.slice(0, 8)})`)
                  launchLog(jid, 'tmux pane died', 'error', 'rclaude crashed during startup')
                  const failMsg: SpawnFailed = {
                    type: 'spawn_failed',
                    conversationId: wid,
                    project: spawnProject,
                    error: 'rclaude process died within 5s of tmux launch - check shell environment, PATH, and hooks',
                  }
                  try {
                    ws.send(JSON.stringify(failMsg))
                  } catch {}
                } else {
                  debug(`tmux health check OK: pane ${paneId} alive (conv=${wid.slice(0, 8)})`, verbose)
                }
              }, 5000)
            }
          }
          diag('spawn', spawnRes.success ? 'Spawn OK' : 'Spawn FAILED', {
            tmuxSession: spawnRes.tmuxSession,
            tmuxPaneId: spawnRes.tmuxPaneId,
            error: spawnRes.error,
          })
          break
        }

        case 'list_dirs': {
          const dirMsg = msg as { requestId: string; path: string }
          const expandedDir = expandPath(dirMsg.path, spawnRoot)
          debug(`Listing dirs: ${expandedDir}`, verbose)
          const dirResult = listDirs(expandedDir)
          const dirResponse: ListDirsResult = {
            type: 'list_dirs_result',
            requestId: dirMsg.requestId,
            dirs: dirResult.dirs,
            error: dirResult.error,
          }
          ws.send(JSON.stringify(dirResponse))
          break
        }

        case 'list_cc_sessions': {
          const sessMsg = msg as { requestId: string; cwd: string; profile?: string }
          const expandedCwd = expandPath(sessMsg.cwd, spawnRoot)
          // Phase 2 honors an optional `profile` field on the request even
          // though the broker does not send it yet -- Phase 3 wires this.
          // Unknown profile name falls back to the default profile's configDir
          // (silent best-effort: this is a UI-aiding read, not a write path).
          let listConfigDir: string
          try {
            listConfigDir = configDirFor(config, sessMsg.profile)
          } catch {
            listConfigDir = configDirFor(config)
          }
          debug(`Listing CC sessions for: ${expandedCwd} (configDir=${listConfigDir})`, verbose)
          const ccSessions = listCcSessions(expandedCwd, listConfigDir)
          const sessResponse: ListCcSessionsResult = {
            type: 'list_cc_sessions_result',
            requestId: sessMsg.requestId,
            ccSessions,
          }
          ws.send(JSON.stringify(sessResponse))
          break
        }

        case 'git_log_request': {
          const gitMsg = msg as GitLogRequest
          const expandedCwd = expandPath(gitMsg.projectUri, spawnRoot)
          debug(`Git log for: ${expandedCwd} (${gitMsg.sinceMs}..${gitMsg.untilMs})`, verbose)
          const outcome = runGitLog(expandedCwd, gitMsg.sinceMs, gitMsg.untilMs)
          const gitResponse: GitLogResult = {
            type: 'git_log_result',
            requestId: gitMsg.requestId,
            projectUri: gitMsg.projectUri,
            success: !outcome.error,
            commits: outcome.commits,
            error: outcome.error,
          }
          ws.send(JSON.stringify(gitResponse))
          break
        }

        case 'git_fabric_request': {
          const fabMsg = msg as GitFabricRequest
          const expandedCwd = expandPath(fabMsg.projectUri, spawnRoot)
          debug(`Git fabric scan for: ${expandedCwd}`, verbose)
          const outcome = runGitFabric(expandedCwd)
          const fabResponse: GitFabricResult = {
            type: 'git_fabric_result',
            requestId: fabMsg.requestId,
            projectUri: fabMsg.projectUri,
            success: !outcome.error,
            fabric: outcome.fabric,
            error: outcome.error,
          }
          ws.send(JSON.stringify(fabResponse))
          break
        }

        case 'project_read_file': {
          const m = msg as ProjectReadFile
          const root = expandPath(m.projectRoot, spawnRoot)
          ws.send(JSON.stringify(handleProjectReadFile(root, m)))
          break
        }

        case 'fetch_artifact': {
          const m = msg as FetchArtifact
          // Resolve the profile's configDir locally (Profile-Env Boundary: the
          // broker passes only the profile NAME). Unknown profile -> structured
          // error rather than a thrown crash in the message loop.
          let configDir: string
          try {
            configDir = configDirFor(config, m.profile)
          } catch (e) {
            ws.send(
              JSON.stringify({
                type: 'fetch_artifact_result',
                requestId: m.requestId,
                ok: false,
                error: (e as Error).message,
              }),
            )
            break
          }
          const patterns = [...BUILTIN_ARTIFACT_PATTERNS, ...config.artifactAllowlist]
          diag('artifact', 'fetch', { profile: m.profile ?? 'default', relPath: m.relPath })
          ws.send(JSON.stringify(handleFetchArtifact(configDir, patterns, m)))
          break
        }

        case 'project_write_file': {
          const m = msg as ProjectWriteFile
          const root = expandPath(m.projectRoot, spawnRoot)
          ws.send(JSON.stringify(handleProjectWriteFile(root, m)))
          break
        }

        case 'project_move_file': {
          const m = msg as ProjectMoveFile
          const root = expandPath(m.projectRoot, spawnRoot)
          ws.send(JSON.stringify(handleProjectMoveFile(root, m)))
          break
        }

        case 'project_board_op': {
          const m = msg as ProjectBoardOp
          const root = expandPath(m.projectRoot, spawnRoot)
          ws.send(JSON.stringify(handleProjectBoardOp(root, m, Date.now())))
          break
        }

        case 'nightshift_op': {
          const m = msg as NightshiftOp
          const root = expandPath(m.projectRoot, spawnRoot)
          ws.send(JSON.stringify(handleNightshiftOp(root, m, Date.now())))
          break
        }

        case 'quest_op': {
          const m = msg as QuestOp
          const root = expandPath(m.projectRoot, spawnRoot)
          ws.send(JSON.stringify(handleQuestOp(root, m, Date.now())))
          break
        }

        case 'project_watch': {
          const m = msg as ProjectWatch
          const root = expandPath(m.project, spawnRoot)
          watchProject(
            root,
            m.project,
            m.leaseMs,
            changed => ws.send(JSON.stringify(changed)),
            l => log(l),
          )
          break
        }

        case 'project_unwatch': {
          const m = msg as ProjectUnwatch
          const root = expandPath(m.project, spawnRoot)
          unwatchProject(root, l => log(l))
          break
        }

        case 'sentinel_patch_config': {
          const ack = handleSentinelPatchConfig(msg as SentinelPatchConfig, config, configPath, spawnRoot)
          ws.send(JSON.stringify(ack))
          break
        }

        case 'shell_open': {
          handleShellOpen(msg as ShellOpen, url, secret)
          break
        }

        case 'shell_close': {
          handleShellClose(msg as ShellClose)
          break
        }
      }
    } catch (err) {
      log(`Failed to handle message: ${err}`)
    }
  }

  ws.onclose = (event: CloseEvent) => {
    activeWs = null
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    stopUsagePolling()
    stopDaemonRosterWatch()
    stopAllWatches(l => log(l))
    if (ccVersionWatcher) {
      ccVersionWatcher.stop()
      ccVersionWatcher = null
    }

    const detail = event.code ? ` (code=${event.code}${event.reason ? ` reason=${event.reason}` : ''})` : ''
    if (shouldReconnect) {
      log(`Disconnected${detail}. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`)
      setTimeout(
        () => connect(url, secret, reviveScript, verbose, spawnRoot, noSpawn, config, configPath),
        RECONNECT_DELAY_MS,
      )
    } else {
      log(`Connection closed${detail}`)
    }
  }

  ws.onerror = err => {
    debug(`WebSocket error: ${err}`, verbose)
  }
}

// Main

// `sentinel profile <subcommand>` runs entirely without a broker connection
// and exits when done. Detect BEFORE arg parsing / WS connect so the user
// can run profile management even on a host without a broker secret.
if (process.argv[2] === 'profile') {
  // Honor a leading `--config <path>` placed before the `profile` keyword as
  // well as after it; parseProfileConfigPath scans the full argv.
  const profileArgs = process.argv.slice(3)
  const exitCode = await runProfileCli(profileArgs, { configPath: extractConfigPath(process.argv) })
  process.exit(exitCode)
}

// `sentinel shell [path]` is a host-side CLI that asks the RUNNING sentinel
// daemon (via its local control socket) to spawn a host shell that appears in
// the control panel. Runs without a broker connection + exits.
if (process.argv[2] === 'shell') {
  const exitCode = await runShellCli(process.argv.slice(3))
  process.exit(exitCode)
}

const { brokerUrl, secret, verbose, reviveScript, spawnRoot, noSpawn, configPath, noShell } = parseArgs()
shellFeatureEnabled = !noShell

let config: SentinelConfig
try {
  config = loadSentinelConfig({ configPath })
} catch (e) {
  console.error(`ERROR: ${(e as Error).message}`)
  process.exit(1)
}

if (config.sourcePath) {
  log(`Loaded sentinel config: ${config.sourcePath}`)
} else {
  log(`No sentinel config at ${configPath ?? defaultConfigPath()} -- using implicit default profile only`)
}
const profileNames = Object.keys(config.profiles).sort()
const poolsList = getPools(config).join(',') || '-'
log(
  `Profiles: ${profileNames.join(', ')} (defaultSelection=${config.defaultSelection}, defaultPool=${config.defaultPool}, pools=[${poolsList}])`,
)

if (!secret) {
  console.error('ERROR: --secret or CLAUDWERK_SENTINEL_SECRET / RCLAUDE_SECRET is required')
  process.exit(1)
}

// Verify revive script exists (still needed for PTY sessions)
try {
  const stat = Bun.spawnSync(['test', '-x', reviveScript])
  if (!stat.success) {
    log(`WARNING: Revive script not found or not executable: ${reviveScript}`)
    log('PTY sessions will fail. Headless direct-spawn still works.')
  }
} catch {
  log(`WARNING: Cannot check revive script: ${reviveScript}`)
}

// Check for rclaude binary (needed for headless direct spawn)
const rclaudeBinCheck = findRclaudeBinary()
if (rclaudeBinCheck) {
  log(`rclaude binary: ${rclaudeBinCheck}`)
} else {
  log('WARNING: rclaude binary not found - headless direct spawn will fail')
}

// Load PID registry from previous run and check for dead children
loadAndCheckPidRegistry()

// SIGTERM handler: unref all children so they survive sentinel restart, write PID registry
// Host-side control socket (the `sentinel shell` entry point). Bound after the
// broker connect below; closed on shutdown so no stale socket file lingers.
let controlSocket: { close: () => void } | null = null

process.on('SIGTERM', () => {
  log(`SIGTERM received. ${trackedChildren.size} tracked children, ${shellRegistry.count} host shells.`)
  controlSocket?.close()
  // Host shells are NOT unref'd -- they are the sentinel's own children and die
  // with it (floating across conversation churn, not across sentinel restart).
  // Kill them cleanly so no orphaned PTY lingers; the broker marks them removed.
  shellRegistry.killAll()
  for (const child of trackedChildren.values()) {
    try {
      child.proc.unref()
      log(`Unrefed PID ${child.pid} (wrapper ${child.conversationId.slice(0, 8)})`)
    } catch (e) {
      log(`Failed to unref PID ${child.pid}: ${e}`)
    }
  }
  writePidRegistry()
  log('PID registry written. Exiting.')
  process.exit(0)
})

// Also handle SIGINT for graceful Ctrl-C shutdown
process.on('SIGINT', () => {
  log(`SIGINT received. ${trackedChildren.size} tracked children, ${shellRegistry.count} host shells.`)
  controlSocket?.close()
  shellRegistry.killAll()
  for (const child of trackedChildren.values()) {
    try {
      child.proc.unref()
    } catch {}
  }
  writePidRegistry()
  process.exit(0)
})

log('Starting sentinel (single instance)')
log(`Host shell: ${shellFeatureEnabled ? 'enabled' : 'DISABLED (--no-shell / CLAUDWERK_NO_SHELL)'}`)
log(`Revive script: ${reviveScript}`)
log(`Spawn root: ${spawnRoot}${noSpawn ? ' (DISABLED)' : ''}`)
// Resolve the on-disk config path the live patch handler writes to. When no
// `--config` was given and no file exists yet, this is the default location --
// a first broker patch will create it (the implicit `default` profile is the
// only profile, so a patch can still tune defaultSelection / defaultPool).
const effectiveConfigPath = config.sourcePath ?? configPath ?? defaultConfigPath()
connect(brokerUrl, secret, reviveScript, verbose, spawnRoot, noSpawn, config, effectiveConfigPath)

// Bind the host-side control socket so `sentinel shell [path]` can ask this
// running daemon to spawn a host shell that surfaces in the control panel. The
// socket file (mode 0600, owner-only) is the auth gate -- a raw $SHELL is RCE as
// the host user, so it stays local + owner-only (never networked).
if (shellFeatureEnabled) {
  controlSocket = startControlSocketServer(
    resolveControlSocketPath(),
    req =>
      handleControlRequest(req, {
        shellEnabled: shellFeatureEnabled,
        openShell: (p, t) => spawnHostShell(p, t, brokerUrl, secret),
      }),
    log,
  )
}

/**
 * Scan `argv` for a `--config <path>` flag. Used by the `sentinel profile`
 * subcommand path which runs before `parseArgs()`. Returns the resolved
 * absolute path or `undefined` when the flag is absent.
 */
function extractConfigPath(argv: string[]): string | undefined {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) return resolve(argv[i + 1])
  }
  return undefined
}
