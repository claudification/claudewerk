/**
 * session-observer -- derive a daemon worker's live `ccSessionId` WITHOUT a hook.
 *
 * claude-agent-host learns CC's session id from the SessionStart hook (PTY) or
 * the stream-json init message (headless). Neither fires here: the Claude Code
 * daemon owns the worker process, so claudewerk never installs a hook into it
 * and never reads its stdout. Two filesystem-ish signals fill the gap.
 *
 * THE INITIAL ccSessionId
 *   - new / resume mode: from the daemon `list` op. The worker was just
 *     dispatched by `claude --bg`, so its `JobRecord.sessionId` IS the live
 *     run id -- no `/clear` can have happened yet.
 *   - attach mode: from the project transcript directory (newest-mtime JSONL).
 *     The worker is pre-existing and MAY have `/clear`'d since dispatch, in
 *     which case `JobRecord.sessionId` is the STALE dispatch-time id (it never
 *     rotates -- spike finding 2). The newest JSONL is the truth. `list`'s id
 *     is only the fallback for the brief window before any JSONL exists.
 *
 * `/clear` ROTATION
 *   A `/clear` inside the worker mints a fresh CC session and a fresh
 *   `<id>.jsonl` -- but the daemon `JobRecord.sessionId` stays pinned to the
 *   dispatch-time id FOREVER (spike finding 2: it is immutable across internal
 *   `/clear`s). So rotation CANNOT be detected from `list`. It is detected by
 *   watching the project dir: when a JSONL strictly newer than the current
 *   session's JSONL appears, that new JSONL's name is the rotated ccSessionId.
 *
 * The daemon `short` is the stable anchor (it maps to claudewerk's
 * `conversationId`); the rotating ccSessionId is just the JSONL file name.
 *
 * Polling (not `subscribe` / `fs.watch`) is deliberate: a `list` call plus a
 * `readdir`+`stat` sweep is a handful of syscalls per second, survives a
 * transient daemon restart with no special handling, and needs no held
 * connection or watcher lifecycle to babysit. `/clear` is rare, so sub-second
 * latency is not required.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { list } from '../shared/cc-daemon/ops'
import type { ListResponse } from '../shared/cc-daemon/types'
import type { DaemonMode } from './cli-args'
import { ccSessionIdFromJsonl, transcriptProjectDir } from './transcript-path'

/** How often to poll the daemon `list` op + the project dir, in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 1000

/** One transcript JSONL in the project dir, with its modification time. */
export interface JsonlEntry {
  /** ccSessionId -- the JSONL file's base name. */
  id: string
  /** Modification time, ms since epoch. */
  mtimeMs: number
}

export interface DaemonSessionObserverOptions {
  /** Path to the daemon `control.sock`. */
  controlSock: string
  /** The 8-hex short id of the worker this conversation hosts. */
  daemonShort: string
  /** Launch mode -- decides where the INITIAL ccSessionId is derived from. */
  mode: DaemonMode
  /** The worker cwd -- used to locate its `~/.claude/projects/<slug>` dir. */
  cwd: string
  /** Fired with the worker's `ccSessionId`: once on boot, then on each `/clear`. */
  onSessionId: (ccSessionId: string) => void
  /** Fired once when the worker leaves the roster (job ended / removed). */
  onGone?: () => void
  /** Fired on a `list` / dir-scan failure. Polling continues -- both are transient. */
  onError?: (err: Error) => void
  /** Poll cadence. Default 1000ms. */
  pollIntervalMs?: number
  /**
   * Override the `list` call -- test seam. Defaults to the real cc-daemon
   * `list` op.
   */
  listFn?: (sockPath: string) => Promise<ListResponse>
  /**
   * Override the project-dir scan -- test seam. Given the project dir, returns
   * its transcript JSONLs sorted newest-mtime first. Defaults to a real
   * `readdir` + `stat` sweep.
   */
  scanProjectDirFn?: (projectDir: string) => Promise<JsonlEntry[]>
}

export interface DaemonSessionObserver {
  /** Stop polling. Idempotent. */
  stop(): void
}

/** Coerce an unknown thrown value into an Error. */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Pick the INITIAL ccSessionId. new/resume trust the just-dispatched worker's
 * `list` id; attach trusts the newest JSONL (the worker may have `/clear`'d,
 * staling the `list` id), falling back to `list` only while no JSONL exists.
 */
function deriveInitialId(mode: DaemonMode, listSessionId: string, scan: JsonlEntry[]): string | null {
  if (mode === 'attach') return scan[0]?.id ?? (listSessionId || null)
  return listSessionId || null
}

/**
 * Detect a `/clear` rotation: a JSONL strictly newer than the current
 * session's JSONL. Returns the rotated id, or `null` for no rotation. The
 * current session's JSONL must be visible (a real mtime baseline) so the
 * window before the worker's own JSONL appears is not a false rotation.
 */
function detectRotation(scan: JsonlEntry[], lastSessionId: string): string | null {
  const current = scan.find(e => e.id === lastSessionId)
  const newest = scan[0]
  if (current && newest && newest.id !== lastSessionId && newest.mtimeMs > current.mtimeMs) {
    return newest.id
  }
  return null
}

/** Default project-dir scan: every `*.jsonl`, newest-mtime first. */
async function scanProjectDir(projectDir: string): Promise<JsonlEntry[]> {
  let names: string[]
  try {
    names = await readdir(projectDir)
  } catch {
    // The project dir does not exist yet -- a fresh cwd before the worker has
    // written anything. Not an error: the next poll will retry.
    return []
  }
  const entries: JsonlEntry[] = []
  for (const name of names) {
    const id = ccSessionIdFromJsonl(name)
    if (!id) continue
    try {
      const st = await stat(join(projectDir, name))
      entries.push({ id, mtimeMs: st.mtimeMs })
    } catch {
      // File vanished between readdir and stat -- skip it.
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return entries
}

/**
 * Start observing the daemon worker `daemonShort` for its `ccSessionId`.
 * Polling begins immediately; the returned handle only exposes `stop()`.
 */
export function observeDaemonSession(opts: DaemonSessionObserverOptions): DaemonSessionObserver {
  const pollList = opts.listFn ?? list
  const scanDir = opts.scanProjectDirFn ?? scanProjectDir
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const projectDir = transcriptProjectDir(opts.cwd)

  /** The ccSessionId most recently reported to `onSessionId`. */
  let lastSessionId: string | null = null
  /** True once the worker has been seen in the roster at least once -- gates
   *  `onGone` so a slow-to-register worker is not mistaken for a dead one. */
  let everSeen = false
  let goneFired = false
  let stopped = false
  let polling = false

  /** Report a ccSessionId to the consumer, de-duped against the last one. */
  function report(id: string): void {
    if (id === lastSessionId) return
    lastSessionId = id
    opts.onSessionId(id)
  }

  /** Worker absent from the roster -- end the conversation if it was ever seen. */
  function noteWorkerAbsent(): void {
    // Absent before it has ever been seen is a startup race (the daemon has
    // not registered the job yet) -- keep waiting. Absent AFTER it was seen
    // means the job ended.
    if (everSeen && !goneFired) {
      goneFired = true
      opts.onGone?.()
    }
  }

  /**
   * Poll the daemon `list` op. Returns the worker's `JobRecord.sessionId`
   * (possibly empty), or `null` if the worker is not in the roster. Drives
   * `everSeen` / `onGone` as a side effect.
   */
  async function pollWorker(): Promise<string | null> {
    let resp: ListResponse
    try {
      resp = await pollList(opts.controlSock)
    } catch (err) {
      if (!stopped) opts.onError?.(toError(err))
      return null
    }
    if (stopped) return null
    const job = resp.jobs.find(j => j.short === opts.daemonShort)
    if (!job) {
      noteWorkerAbsent()
      return null
    }
    everSeen = true
    return job.sessionId
  }

  /** Scan the project transcript dir, surfacing failures via `onError`. */
  async function pollDir(): Promise<JsonlEntry[]> {
    try {
      return await scanDir(projectDir)
    } catch (err) {
      if (!stopped) opts.onError?.(toError(err))
      return []
    }
  }

  async function poll(): Promise<void> {
    if (stopped || polling) return
    polling = true
    try {
      const listSessionId = await pollWorker()
      if (stopped || goneFired) return
      const scan = await pollDir()
      if (stopped) return

      const next =
        lastSessionId === null
          ? deriveInitialId(opts.mode, listSessionId ?? '', scan)
          : detectRotation(scan, lastSessionId)
      if (next) report(next)
    } finally {
      polling = false
    }
  }

  const timer: ReturnType<typeof setInterval> = setInterval(poll, pollIntervalMs)
  // Kick an immediate first poll so a fast-booting worker is not delayed by a
  // full interval before the host can attach.
  void poll()

  return {
    stop(): void {
      stopped = true
      clearInterval(timer)
    },
  }
}
