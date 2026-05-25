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
 *   - attach mode: from the worker process's OPEN JSONL file descriptor
 *     (lsof on `JobRecord.pid`). The worker is pre-existing and MAY have
 *     `/clear`'d since dispatch, in which case `JobRecord.sessionId` is the
 *     STALE dispatch-time id (it never rotates -- spike finding 2). The pid's
 *     open .jsonl IS the truth. The project transcript dir is a LAST-RESORT
 *     fallback (process-correlation unavailable) -- see CROSS-WIRE HAZARD.
 *
 * `/clear` ROTATION
 *   A `/clear` inside the worker mints a fresh CC session and a fresh
 *   `<id>.jsonl` -- but the daemon `JobRecord.sessionId` stays pinned to the
 *   dispatch-time id FOREVER (spike finding 2). The reliable signal is the
 *   worker process's currently-open .jsonl fd (via lsof). The dir-scan path
 *   is only safe when no other CC sessions share the project dir (see below).
 *
 * CROSS-WIRE HAZARD (the bug this module had until the lsof rewrite, 2026-05-26)
 *   `~/.claude/projects/<slug>/` is SHARED across every CC process targeting
 *   that cwd -- daemon workers AND user-interactive `rclaude` / `claude` runs.
 *   The original dir-scan heuristic ("newest-mtime JSONL is the worker's")
 *   cross-wired every daemon conv to whichever rclaude conv last touched its
 *   JSONL in the same project. Symptoms: two conversations reporting the same
 *   `ccSessionId`, silent name swaps (`lucky-banana` -> `jolly-koala`), and
 *   `/clear`-on-idle phantom transitions. The pid-fd lookup correlates by
 *   process, not file mtime -- impossible to cross-wire as long as the daemon
 *   gives us a `pid` (it does; live-verified on CC 2.1.150).
 *
 * The daemon `short` is the stable anchor (it maps to claudewerk's
 * `conversationId`); the rotating ccSessionId is just the JSONL file name.
 *
 * Polling (not `subscribe` / `fs.watch`) is deliberate: a `list` call plus a
 * targeted `lsof -p <pid>` (or `readdir`+`stat` fallback) is a handful of
 * syscalls per second, survives a transient daemon restart with no special
 * handling, and needs no held connection or watcher lifecycle to babysit.
 * `/clear` is rare, so sub-second latency is not required.
 */
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { list } from '../shared/cc-daemon/ops'
import type { JobRecord, ListResponse } from '../shared/cc-daemon/types'
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
   * `readdir` + `stat` sweep. This is the LAST-RESORT fallback when the daemon
   * does not expose a pid -- see CROSS-WIRE HAZARD in the module docstring.
   */
  scanProjectDirFn?: (projectDir: string) => Promise<JsonlEntry[]>
  /**
   * Override the pid -> open-JSONL lookup -- test seam. Given the worker's pid
   * and the project transcript dir, returns the ccSessionId of the .jsonl file
   * the worker process currently has open (its live transcript). `null` means
   * the lookup failed / no .jsonl is open / the platform does not support it.
   * Defaults to `lsof -p <pid>` on darwin and linux. This is the PRIMARY
   * signal -- it correlates by process, not by file mtime, so it cannot
   * cross-wire to other CC sessions sharing the project dir.
   */
  jsonlByPidFn?: (pid: number, projectDir: string) => Promise<string | null>
}

/**
 * The most recent observation made by the poller. Surfaced for the classifier
 * that decides whether a "vanished from roster" event should be reclassified
 * as `daemon_session_retired` (long-idle session retired by the daemon) vs. a
 * generic disconnect.
 */
export interface LastObservation {
  /** Last `JobRecord.state` value seen for this worker. Freeform daemon string. */
  state: string
  /** Epoch ms when state most recently entered `'idle'`. `null` when the last
   *  observation was not `idle`. */
  idleSinceMs: number | null
  /** Epoch ms of the most recent observation. */
  at: number
}

export interface DaemonSessionObserver {
  /** Stop polling. Idempotent. */
  stop(): void
  /** Return the most recent observation (state + idleSinceMs). `null` until the
   *  worker has been seen in the roster at least once. */
  lastObservation(): LastObservation | null
}

/** Coerce an unknown thrown value into an Error. */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Advance the observation snapshot for a fresh poll. `'idle'` is the literal
 * daemon state for a worker waiting for input; once the state leaves `'idle'`
 * the idleSinceMs baseline clears so a back-to-busy worker is not counted as
 * long-idle on its next vanish. Pure -- testable without the observer.
 */
function nextObservation(prev: LastObservation | null, state: string, now: number): LastObservation {
  if (state !== 'idle') return { state, idleSinceMs: null, at: now }
  const idleSinceMs = prev?.state === 'idle' && prev.idleSinceMs !== null ? prev.idleSinceMs : now
  return { state, idleSinceMs, at: now }
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

/**
 * Default pid -> open-JSONL lookup. Shells `lsof -p <pid>` and walks its
 * output for a `.jsonl` path under `projectDir`. The first match's file name
 * (stem) IS the worker's live ccSessionId. Returns `null` on lsof failure,
 * no match, or any platform that does not ship lsof. Pure subprocess wrapper
 * -- no side effects.
 *
 * Why this is correct: CC opens the transcript file for write while a turn is
 * running, and re-opens on append. Under load the fd is always present; in
 * deep idle it may be briefly closed, in which case we return `null` and the
 * caller treats it as "no new observation this poll" (NOT a rotation -- see
 * CROSS-WIRE HAZARD).
 */
function defaultJsonlByPid(pid: number, projectDir: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile('lsof', ['-p', String(pid), '+c', '0'], { timeout: 2_000 }, (err, stdout) => {
      if (err) return resolve(null)
      const lines = stdout.split('\n')
      for (const line of lines) {
        const idx = line.indexOf(projectDir)
        if (idx < 0) continue
        const path = line.slice(idx).trim()
        if (!path.endsWith('.jsonl')) continue
        const name = path.slice(path.lastIndexOf('/') + 1)
        const id = ccSessionIdFromJsonl(name)
        if (id) return resolve(id)
      }
      resolve(null)
    })
  })
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
  const lookupJsonlByPid = opts.jsonlByPidFn ?? defaultJsonlByPid
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
  /** Most recent `JobRecord.state` + idle-since timestamp for this worker.
   *  Drives `lastObservation()` for the retirement classifier. */
  let lastObservation: LastObservation | null = null

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
   * Poll the daemon `list` op. Returns the worker's `JobRecord` (used for both
   * its dispatch-time `sessionId` and its `pid` -- the pid feeds the lsof-based
   * live-session lookup that defeats the project-dir cross-wire), or `null` if
   * the worker is not in the roster. Drives `everSeen` / `onGone` as a side
   * effect.
   */
  async function pollWorker(): Promise<JobRecord | null> {
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
    lastObservation = nextObservation(lastObservation, job.state, Date.now())
    return job
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

  /**
   * Try the pid-based correlation. Returns `'handled'` if a session was
   * reported (or if pid was present but lsof was empty AND we already had a
   * session -- the cross-wire-guard "hold the last id" path). Returns
   * `'try-fallback'` only when we have no pid at all, OR when pid+lsof gave
   * nothing AND we never had a session (so the fallback is the only chance to
   * establish an initial id).
   */
  async function tryPidLookup(job: JobRecord): Promise<'handled' | 'try-fallback'> {
    if (job.pid === undefined) return 'try-fallback'
    const live = await lookupJsonlByPid(job.pid, projectDir)
    if (stopped) return 'handled'
    if (live) {
      report(live)
      return 'handled'
    }
    // pid is known but lsof returned nothing (deep idle, fd briefly closed).
    // If we already have a session, HOLD it -- the dir-scan fallback would
    // cross-wire to another conv. If we have NO session yet, fall back so the
    // observer can at least bootstrap.
    return lastSessionId !== null ? 'handled' : 'try-fallback'
  }

  /** Dir-scan fallback path -- only safe when pid correlation is unavailable. */
  async function runDirScanFallback(job: JobRecord): Promise<void> {
    const scan = await pollDir()
    if (stopped) return
    const next =
      lastSessionId === null
        ? deriveInitialId(opts.mode, job.sessionId ?? '', scan)
        : detectRotation(scan, lastSessionId)
    if (next) report(next)
  }

  async function poll(): Promise<void> {
    if (stopped || polling) return
    polling = true
    try {
      const job = await pollWorker()
      if (stopped || goneFired || !job) return
      const outcome = await tryPidLookup(job)
      if (stopped || outcome === 'handled') return
      await runDirScanFallback(job)
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
    lastObservation(): LastObservation | null {
      return lastObservation
    },
  }
}

/** Threshold: a worker that has been idle this long before vanishing from the
 *  daemon roster is classified as `daemon_session_retired` instead of crashed.
 *  The daemon's own idle-retire policy is ~5min; we trip slightly under that. */
export const SESSION_RETIRED_IDLE_MS = 4.5 * 60_000

/**
 * Classifier: did this worker vanish because the daemon retired a long-idle
 * session, or because something else (crash, kill, daemon restart) ended it?
 *
 * Returns the classifier verdict and, for the retired case, the millisecond
 * idle window. Pure -- testable without the observer.
 */
export function classifyVanish(
  lastObservation: LastObservation | null,
  nowMs: number,
): { retired: true; idleMs: number; lastState: 'idle' } | { retired: false; lastState?: string; idleMs?: number } {
  if (!lastObservation) return { retired: false }
  if (lastObservation.state !== 'idle' || lastObservation.idleSinceMs === null) {
    return { retired: false, lastState: lastObservation.state }
  }
  const idleMs = nowMs - lastObservation.idleSinceMs
  if (idleMs < SESSION_RETIRED_IDLE_MS) return { retired: false, lastState: 'idle', idleMs }
  return { retired: true, idleMs, lastState: 'idle' }
}
