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
import { homedir } from 'node:os'
import { join } from 'node:path'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { list } from '../shared/cc-daemon/ops'
import { resolveControlSocket } from '../shared/cc-daemon/socket-path'
import { CC_DAEMON_PROTO, type JobRecord } from '../shared/cc-daemon/types'
import type { DaemonJobInfo, DaemonRosterUpdate } from '../shared/protocol'

const DAEMON_DIR = join(homedir(), '.claude', 'daemon')
const MAP_PATH = join(homedir(), '.claude', 'claudewerk-daemon-map.json')
/** Poll fallback -- chokidar gives instant updates, the poll is the floor. */
const POLL_INTERVAL_MS = 10_000

/** Logging hooks supplied by the sentinel (`log` + structured `diag`). */
export interface RosterWatchDeps {
  log: (msg: string) => void
  diag: (type: string, msg: string, args?: unknown) => void
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
): { infos: DaemonJobInfo[]; mutated: boolean } {
  const sizeBefore = Object.keys(idMap).length
  const infos: DaemonJobInfo[] = jobs
    .filter(job => job.sessionId && job.short) // drop malformed records
    .map(job => ({ ...job, conversationId: conversationIdFor(job.sessionId, idMap) }))
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

/** Resolve the current roster and shape it into a DaemonRosterUpdate. */
async function buildRosterUpdate(deps: RosterWatchDeps): Promise<DaemonRosterUpdate> {
  const observedAt = Date.now()
  const sock = resolveControlSocket()
  if (!sock) {
    return { type: 'daemon_roster_update', daemonPresent: false, jobs: [], observedAt }
  }
  try {
    const { jobs } = await list(sock)
    const { infos, mutated } = buildJobInfos(jobs, idMap)
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
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (watcher) {
    void watcher.close()
    watcher = null
  }
}
