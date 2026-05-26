/**
 * Sentinel-side watcher for the Claude Code background-session daemon.
 *
 * Phase 1 of the daemon integration (the read-only mirror): the sentinel
 * observes native `claude agents` background sessions and pushes them to the
 * broker as `DaemonRosterUpdate` messages; the broker surfaces them as
 * read-only Conversation rows. See
 * `.claude/docs/plan-claude-agents-integration.md`.
 *
 * Verified ops only -- `list` over the control socket. No `lease` (the daemon
 * is left to idle-exit on its own; the lease is a Phase 2 concern) and no
 * per-job `subscribe` streams yet (deferred -- roster.json-grain updates are
 * enough for a read-only mirror).
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { list } from '../shared/cc-daemon/ops'
import { resolveControlSocket } from '../shared/cc-daemon/socket-path'
import { CC_DAEMON_PROTO, type JobRecord } from '../shared/cc-daemon/types'
import { claudeConfigDir } from '../shared/claude-config-dir'
import type { DaemonJobInfo, DaemonRosterUpdate } from '../shared/protocol'

/**
 * Resolve the daemon dir + id-map path under the ACTIVE config dir.
 *
 * Transport-reframe Phase 2 (§ 0.7): these used to hardcode `~/.claude`, so a
 * sentinel running under a profile `CLAUDE_CONFIG_DIR=/other` watched the wrong
 * directory and never saw that daemon's roster. `claudeConfigDir()` honors
 * CLAUDE_CONFIG_DIR, making the watcher correct for whichever single profile
 * the sentinel process runs under. `env` is the test seam.
 *
 * SCOPE (§ 7.6 decision): this resolves the sentinel's ONE active config dir.
 * Watching MULTIPLE profile configDirs at once (a per-profile daemon each) is
 * deferred -- the control socket resolves per-uid (`/tmp/cc-daemon-<uid>`), not
 * per-configDir, so a true multi-daemon mirror needs a configDir-keyed socket
 * resolver + N watchers, which is out of scope for the transport reframe.
 */
export function daemonRosterPaths(env: NodeJS.ProcessEnv = process.env): { daemonDir: string; mapPath: string } {
  const configDir = claudeConfigDir(env)
  return { daemonDir: join(configDir, 'daemon'), mapPath: join(configDir, 'claudewerk-daemon-map.json') }
}

const { daemonDir: DAEMON_DIR, mapPath: MAP_PATH } = daemonRosterPaths()
/** Poll fallback -- chokidar gives instant updates, the poll is the floor. */
const POLL_INTERVAL_MS = 10_000
/** The CLAUDE_CONFIG_DIR whose daemon this roster watches (fixed at module load,
 *  matches `daemonRosterPaths`). Scopes `registerDaemonSession`: only sessions on
 *  THIS daemon can produce a duplicate ghost here. */
const WATCHED_CONFIG_DIR = claudeConfigDir()

/** Logging hooks supplied by the sentinel (`log` + structured `diag`). */
export interface RosterWatchDeps {
  log: (msg: string) => void
  diag: (type: string, msg: string, args?: unknown) => void
  /**
   * Active sentinel-profile NAME the polled daemon socket belongs to. Stamped
   * onto every roster job so the broker can set `Conversation.resolvedProfile`
   * for ghost (read-only daemon) conversations. `undefined` means default.
   * PROFILE-ENV BOUNDARY: NAME only -- configDir/env stay sentinel-resident.
   */
  profile?: string
}

/** Mint a fresh claudewerk conversationId (`conv_` + 12 url-safe chars). */
export function mintConversationId(): string {
  return `conv_${randomBytes(9).toString('base64url')}`
}

/** Look up the conversationId for a daemon session, minting one if unseen. */
function conversationIdFor(sessionId: string, idMap: Record<string, string>): string {
  const existing = idMap[sessionId]
  if (existing) return existing
  const minted = mintConversationId()
  idMap[sessionId] = minted
  return minted
}

/**
 * Map daemon JobRecords to DaemonJobInfos, resolving each one's stable
 * conversationId from `idMap` (keyed by the daemon `sessionId`, which
 * survives daemon restarts) and minting one on first sighting. Pure apart
 * from mutating `idMap`; returns `mutated` so the caller can persist it.
 */
export function buildJobInfos(
  jobs: JobRecord[],
  idMap: Record<string, string>,
  profile?: string,
): { infos: DaemonJobInfo[]; mutated: boolean } {
  const sizeBefore = Object.keys(idMap).length
  const infos: DaemonJobInfo[] = jobs
    .filter(job => job.sessionId && job.short) // drop malformed records
    .map(job => {
      const info: DaemonJobInfo = { ...job, conversationId: conversationIdFor(job.sessionId, idMap) }
      if (profile) info.profile = profile
      return info
    })
  return { infos, mutated: Object.keys(idMap).length !== sizeBefore }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function loadIdMap(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(MAP_PATH, 'utf8')) as Record<string, string>
  } catch {
    return {} // absent or unparseable -- start fresh
  }
}

function saveIdMap(idMap: Record<string, string>, deps: RosterWatchDeps): void {
  try {
    writeFileSync(MAP_PATH, JSON.stringify(idMap, null, 2))
  } catch (err) {
    deps.diag('daemon', `Could not persist daemon id map: ${errMsg(err)}`)
  }
}

// --- module state ------------------------------------------------------------
let watcher: FSWatcher | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let running = false
let idMap: Record<string, string> = {}
/** Deps captured while the watch runs, so `registerDaemonSession` (called from
 *  the spawn dispatch path, not the poll loop) can persist + diag against the
 *  live idMap. Null when no watch is active. */
let currentDeps: RosterWatchDeps | null = null

/**
 * Register a claudewerk-OWNED daemon session -> conversationId in the LIVE idMap
 * so the roster mirror's `conversationIdFor` reuses this conversationId instead
 * of minting a duplicate GHOST row for the same worker. Called by the spawn
 * dispatch path right after a NEW daemon dispatch -- the minted sessionId
 * BECOMES the worker's ccSessionId for a NEW dispatch (cc-daemon types.ts), so
 * it is the authoritative key the roster will later see for this worker.
 *
 * Without this, claudewerk's own daemon spawn (conversationId minted broker-side)
 * and the roster mirror (conversationId minted here, keyed by sessionId) derive
 * DIFFERENT ids for the same worker -> two rows: the transcript/worker on one,
 * an empty ghost on the other (the split-identity bug).
 *
 * No-op (returns false) when: the roster watch is not running; ids are empty;
 * the worker's daemon (configDir) is not the one this roster watches (a
 * cross-profile worker the roster never mirrors -- no ghost to prevent); or the
 * session is already mapped to a DIFFERENT conversation (never clobber).
 */
export type SessionRegistrationVerdict = 'register' | 'idempotent' | 'skip-empty' | 'skip-foreign' | 'skip-conflict'

/**
 * PURE decision for {@link registerDaemonSession}: given the current idMap and
 * configDir scoping, decide whether the session -> conversation mapping should
 * be written. `skip-foreign` = the worker's daemon is not the one this roster
 * watches (no ghost to prevent); `skip-conflict` = the session already maps to a
 * DIFFERENT conversation (never clobber); `idempotent` = already mapped to the
 * same conversation. Testable without the module state.
 */
export function planSessionRegistration(
  idMap: Record<string, string>,
  sessionId: string,
  conversationId: string,
  workerConfigDir: string | undefined,
  watchedConfigDir: string,
): SessionRegistrationVerdict {
  if (!sessionId || !conversationId) return 'skip-empty'
  if (workerConfigDir && resolve(workerConfigDir) !== resolve(watchedConfigDir)) return 'skip-foreign'
  const existing = idMap[sessionId]
  if (existing === conversationId) return 'idempotent'
  if (existing) return 'skip-conflict'
  return 'register'
}

export function registerDaemonSession(sessionId: string, conversationId: string, workerConfigDir?: string): boolean {
  if (!running || !currentDeps) return false
  const verdict = planSessionRegistration(idMap, sessionId, conversationId, workerConfigDir, WATCHED_CONFIG_DIR)
  if (verdict === 'idempotent') return true
  if (verdict === 'skip-conflict') {
    currentDeps.diag('daemon', 'register: session already mapped, not clobbering', {
      sessionId: sessionId.slice(0, 12),
      existing: idMap[sessionId],
      incoming: conversationId,
    })
    return false
  }
  if (verdict !== 'register') return false
  idMap[sessionId] = conversationId
  saveIdMap(idMap, currentDeps)
  currentDeps.diag('daemon', 'register: claudewerk daemon spawn session -> conversation', {
    sessionId: sessionId.slice(0, 12),
    conversationId,
  })
  return true
}

/** Resolve the current roster and shape it into a DaemonRosterUpdate. */
async function buildRosterUpdate(deps: RosterWatchDeps): Promise<DaemonRosterUpdate> {
  const observedAt = Date.now()
  const sock = resolveControlSocket()
  if (!sock) {
    return { type: 'daemon_roster_update', daemonPresent: false, jobs: [], observedAt }
  }
  try {
    const { jobs } = await list(sock)
    const { infos, mutated } = buildJobInfos(jobs, idMap, deps.profile)
    if (mutated) saveIdMap(idMap, deps)
    return {
      type: 'daemon_roster_update',
      daemonPresent: true,
      daemonProto: CC_DAEMON_PROTO,
      jobs: infos,
      observedAt,
    }
  } catch (err) {
    // Daemon idle-exited mid-call, or bumped the control protocol. Either way
    // the mirror reports it absent rather than crashing the sentinel.
    deps.diag('daemon', `list failed, reporting daemon absent: ${errMsg(err)}`)
    return { type: 'daemon_roster_update', daemonPresent: false, jobs: [], observedAt }
  }
}

/** Resolve the roster and push one DaemonRosterUpdate to the broker. */
async function scanAndPush(ws: WebSocket, deps: RosterWatchDeps): Promise<void> {
  if (!running) return
  const update = await buildRosterUpdate(deps)
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(update))
    deps.diag('daemon', 'Roster pushed', {
      daemonPresent: update.daemonPresent,
      jobs: update.jobs.length,
    })
  }
}

/** Attach the chokidar watcher once the daemon dir exists. Idempotent. */
function ensureWatcher(scan: () => void, deps: RosterWatchDeps): void {
  if (watcher || !existsSync(DAEMON_DIR)) return
  // Watch the parent dir (depth 0), filter by name: the Bun/macOS fs.watch
  // gotcha is that re-creating a watcher on the file itself drops events.
  const fsWatcher = chokidarWatch(DAEMON_DIR, { depth: 0, ignoreInitial: true })
  const onEvent = (path: string): void => {
    if (path.endsWith('roster.json')) scan()
  }
  fsWatcher.on('add', onEvent).on('change', onEvent).on('unlink', onEvent)
  fsWatcher.on('error', err => deps.diag('daemon', `Roster watcher error: ${errMsg(err)}`))
  watcher = fsWatcher
  deps.diag('daemon', 'Roster file watcher attached', { dir: DAEMON_DIR })
}

/**
 * Start mirroring the daemon roster to the broker over `ws`. Pushes once
 * immediately, then on every roster.json change and on a poll fallback.
 */
export function startDaemonRosterWatch(ws: WebSocket, deps: RosterWatchDeps): void {
  stopDaemonRosterWatch()
  running = true
  currentDeps = deps
  idMap = loadIdMap()
  deps.log('Daemon roster watch started')
  deps.diag('daemon', 'Roster watch started', { pollMs: POLL_INTERVAL_MS })

  const scan = (): void => {
    scanAndPush(ws, deps).catch(err => deps.diag('daemon', `Roster scan error: ${errMsg(err)}`))
  }

  scan() // immediate
  ensureWatcher(scan, deps)
  pollTimer = setInterval(() => {
    ensureWatcher(scan, deps) // lazily attach once the daemon dir appears
    scan()
  }, POLL_INTERVAL_MS)
}

/** Stop the roster watch and release the file watcher. Idempotent. */
export function stopDaemonRosterWatch(): void {
  running = false
  currentDeps = null
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (watcher) {
    void watcher.close()
    watcher = null
  }
}
