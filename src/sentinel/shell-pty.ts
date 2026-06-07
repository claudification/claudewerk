/**
 * Host-shell PTY registry (sentinel-owned).
 *
 * A host shell is a property of *a host at a path* (`claude://{sentinel}/{path}`),
 * NOT of a conversation -- so the sentinel owns the PTY, survives conversation
 * churn, and the URI is the permission boundary (plan-host-shell.md 1).
 *
 * This module is the sentinel's source of truth for live shells: spawn a
 * scrubbed `$SHELL` PTY, append output to a per-shell ring buffer (for
 * reconnect/expand replay), gate live streaming behind attach/detach (lazy
 * "no bytes until expanded", 0.1), apply the broker-computed authoritative size
 * (min-size policy lives broker-side because viewer identity only exists there;
 * see 4.1), and coalesce activity blinks.
 *
 * Wire I/O lives in `shell-data-ws.ts` (data plane) + `index.ts` (control
 * plane). This module knows nothing about WebSockets -- callers wire callbacks.
 */

import type { Subprocess } from 'bun'

/** Per-shell scrollback retained on the sentinel for replay-on-expand. */
const RING_BUFFER_BYTES = 256 * 1024

/** Activity-coalesce floor -- the index.ts flusher drains at most this often. */
export const ACTIVITY_COALESCE_MS = 250 // ~4/sec (plan 4.3)

/** A PTY has ONE size; the broker reduces all viewers to a single min before it
 *  reaches us, but this floor guards against a degenerate 0 that would wedge the
 *  terminal. tmux uses a similar small floor. */
const MIN_DIMENSION = 1

/**
 * Resolve the default shell + interactive-login argv (plan 4.6).
 * `$SHELL` || (`/bin/zsh` on darwin, `/bin/bash` else). Login + interactive so
 * the user's rc/profile loads, exactly like opening a terminal on the host.
 */
export function resolveShellCommand(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const shell = env.SHELL && env.SHELL.length > 0 ? env.SHELL : platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  return [shell, '-l', '-i']
}

/** Exact-name env vars to strip before spawning a raw shell (fleet credentials
 *  + account routing). A raw `$SHELL` is RCE as the host user -- never leak the
 *  fleet's secrets into it (plan 4.4, mirrors start-sentinel scrub 5ec4cd23). */
const SCRUB_EXACT = new Set([
  'CLAUDECODE',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
])

/** Substring patterns that catch generic `.env` secrets (NPM_TOKEN, *_API_KEY,
 *  VAPID_PRIVATE_KEY, ...) without enumerating every one -- so a future .env
 *  secret is scrubbed automatically, same spirit as start-sentinel #3. */
const SCRUB_PATTERN = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY)/i

/** Fleet branding / Claude Code session prefixes a user shell must never see. */
const SCRUB_PREFIX = /^(CLAUDWERK_|RCLAUDE_|CLAUDE_CODE_)/

/** True when an env var must never reach a raw user shell: fleet branding
 *  prefixes, Claude Code session state + account/billing routing, or anything
 *  name-matching the generic secret pattern. */
function isSensitiveShellEnvKey(key: string): boolean {
  return SCRUB_PREFIX.test(key) || SCRUB_EXACT.has(key) || SCRUB_PATTERN.test(key)
}

/**
 * Return a copy of `baseEnv` safe to hand a raw user shell -- every fleet
 * credential / account-routing / secret var stripped (see
 * `isSensitiveShellEnvKey`). Sets `TERM=xterm-256color` (the remote viewer IS
 * xterm). Drops `undefined` values so the result is a clean
 * `Record<string,string>` for `Bun.spawn`.
 */
export function scrubShellEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isSensitiveShellEnvKey(key)) continue
    out[key] = value
  }
  out.TERM = 'xterm-256color'
  // Advertise 24-bit color so TUIs (neovim, etc.) emit true-color escapes
  // instead of down-mapping to the 256 palette. The remote viewer is xterm.js,
  // which renders truecolor correctly via the DOM renderer.
  out.COLORTERM = 'truecolor'
  return out
}

/**
 * Reduce a set of per-viewer desired sizes to the single PTY size (tmux-style
 * min). Exported for the broker (phase 3) to import -- the broker owns the
 * per-viewer map and calls this before sending the authoritative `shell_resize`
 * / `shell_attach`. Co-located here so the size policy lives with the PTY code
 * and has one tested implementation (plan 4.1). Empty set -> a sane default.
 */
export function minSize(
  sizes: Array<{ cols: number; rows: number }>,
  fallback: { cols: number; rows: number } = { cols: 80, rows: 24 },
): { cols: number; rows: number } {
  if (sizes.length === 0) return { cols: fallback.cols, rows: fallback.rows }
  return {
    cols: Math.max(MIN_DIMENSION, Math.min(...sizes.map(s => s.cols))),
    rows: Math.max(MIN_DIMENSION, Math.min(...sizes.map(s => s.rows))),
  }
}

/**
 * Byte-capped scrollback. Appends decoded PTY output, evicting whole chunks
 * from the front once the retained byte total exceeds the cap. `dump()`
 * reconstructs the retained tail for replay-on-expand.
 */
export class RingBuffer {
  private chunks: string[] = []
  private bytes = 0
  constructor(private readonly capBytes: number = RING_BUFFER_BYTES) {}

  append(data: string): void {
    if (data.length === 0) return
    this.chunks.push(data)
    this.bytes += Buffer.byteLength(data, 'utf8')
    // `length > 1` guarantees shift() yields a string, so the cast is safe --
    // we never evict the sole chunk even if it alone exceeds the cap.
    while (this.bytes > this.capBytes && this.chunks.length > 1) {
      this.bytes -= Buffer.byteLength(this.chunks.shift() as string, 'utf8')
    }
  }

  dump(): string {
    return this.chunks.join('')
  }

  get byteLength(): number {
    return this.bytes
  }
}

/** A single live host shell. */
interface ShellEntry {
  shellId: string
  projectUri: string
  path: string
  title: string
  createdBy: string | undefined
  createdAt: number
  proc: Subprocess
  ring: RingBuffer
  /** Authoritative PTY size (broker-computed min across viewers). */
  size: { cols: number; rows: number }
  /** ≥1 viewer subscribed -> forward live `shell_data`. */
  attached: boolean
  /** Output happened since the last activity drain. */
  activityDirty: boolean
  exited: boolean
}

/** Decode a PTY byte chunk to a clean string: streaming UTF-8 (handles split
 *  multi-byte sequences) with U+FFFD replacement chars stripped (invalid bytes
 *  from binary output). Returns '' on decode failure or empty input. */
function decodeChunk(decoder: TextDecoder, bytes: Uint8Array): string {
  let decoded: string
  try {
    decoded = decoder.decode(bytes, { stream: true })
  } catch {
    return ''
  }
  if (decoded.length === 0) return ''
  return decoded.indexOf('�') >= 0 ? decoded.replaceAll('�', '') : decoded
}

export interface ShellSpawnOpts {
  shellId: string
  projectUri: string
  /** Working directory = URI path / project root (the permission unit). */
  path: string
  title: string
  cols: number
  rows: number
  /** Identity that opened the shell, for sentinel-side logging only -- the
   *  broker owns the roster's authoritative `createdBy`. Optional/empty here. */
  createdBy?: string
  /** Base env to scrub (default `process.env`). Test seam. */
  baseEnv?: Record<string, string | undefined>
  /** Platform for shell resolution (default `process.platform`). Test seam. */
  platform?: NodeJS.Platform
  /** Full argv override. Defaults to `resolveShellCommand`. Test seam +
   *  forward-compat (host-management could run a fixed command). */
  argv?: string[]
}

export interface ShellCallbacks {
  /** Live PTY output for a shell that is currently attached (≥1 viewer). The
   *  ring buffer is appended regardless; this fires only while attached. */
  onData: (shellId: string, data: string) => void
  /** PTY exited (code, or the spawn threw). Fired exactly once. */
  onExit: (shellId: string, code: number) => void
}

/** Public roster-shaped view of a live entry (no PTY handle). */
export interface ShellInfo {
  shellId: string
  projectUri: string
  path: string
  title: string
  createdBy: string
  createdAt: number
}

/**
 * In-memory registry of all live host shells on this sentinel, keyed by
 * `shellId`. Pure of WebSocket concerns: callers wire `onData`/`onExit`.
 */
export class ShellRegistry {
  private shells = new Map<string, ShellEntry>()

  /** Number of live shells -- drives data-WS open-on-first / close-on-last. */
  get count(): number {
    return this.shells.size
  }

  has(shellId: string): boolean {
    return this.shells.has(shellId)
  }

  isAttached(shellId: string): boolean {
    return this.shells.get(shellId)?.attached ?? false
  }

  /** Roster snapshot of every live shell (for control-plane resync on a broker
   *  reconnect -- the sentinel re-announces what it still has running). */
  list(): ShellInfo[] {
    return [...this.shells.values()].map(toInfo)
  }

  /**
   * Spawn a scrubbed `$SHELL` PTY at `opts.path`. Output flows to the ring
   * buffer always + `onData` while attached. Throws (synchronously) if the
   * shellId is already live or the spawn fails -- the caller maps that to a
   * `shell_exit`.
   */
  spawn(opts: ShellSpawnOpts, cb: ShellCallbacks): ShellInfo {
    if (this.shells.has(opts.shellId)) {
      throw new Error(`shell ${opts.shellId} already exists`)
    }
    const baseEnv = opts.baseEnv ?? process.env
    const argv = opts.argv ?? resolveShellCommand(baseEnv, opts.platform)
    const cols = Math.max(MIN_DIMENSION, opts.cols)
    const rows = Math.max(MIN_DIMENSION, opts.rows)
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const id = opts.shellId

    const proc = Bun.spawn(argv, {
      cwd: opts.path,
      env: scrubShellEnv(baseEnv),
      terminal: {
        cols,
        rows,
        data: (_terminal, bytes) => this.onPtyData(id, decodeChunk(decoder, bytes), cb),
      },
      onExit: (_proc, exitCode) => this.onPtyExit(id, exitCode, cb),
    })

    const entry: ShellEntry = {
      shellId: id,
      projectUri: opts.projectUri,
      path: opts.path,
      title: opts.title,
      createdBy: opts.createdBy,
      createdAt: Date.now(),
      proc,
      ring: new RingBuffer(),
      size: { cols, rows },
      attached: false,
      activityDirty: false,
      exited: false,
    }
    this.shells.set(id, entry)
    return toInfo(entry)
  }

  /** PTY output: always buffer to the ring + mark activity; forward live only
   *  while attached (lazy "no bytes until expanded"). Empty decode = no-op. */
  private onPtyData(shellId: string, decoded: string, cb: ShellCallbacks): void {
    const entry = this.shells.get(shellId)
    if (!decoded || !entry) return
    entry.ring.append(decoded)
    entry.activityDirty = true
    if (entry.attached) cb.onData(shellId, decoded)
  }

  /** PTY exited: remove from the roster + fire `onExit` exactly once. A signal
   *  kill yields a null exit code -> normalize to 0. */
  private onPtyExit(shellId: string, code: number | null, cb: ShellCallbacks): void {
    const entry = this.shells.get(shellId)
    if (!entry || entry.exited) return
    entry.exited = true
    this.shells.delete(shellId)
    cb.onExit(shellId, code ?? 0)
  }

  /** Write keystrokes to the PTY. No-op for an unknown/exited shell. */
  write(shellId: string, data: string): void {
    this.shells.get(shellId)?.proc.terminal?.write(data)
  }

  /** Apply the authoritative (broker-computed) size to the PTY. */
  resize(shellId: string, cols: number, rows: number): void {
    const entry = this.shells.get(shellId)
    if (!entry) return
    entry.size = { cols: Math.max(MIN_DIMENSION, cols), rows: Math.max(MIN_DIMENSION, rows) }
    entry.proc.terminal?.resize(entry.size.cols, entry.size.rows)
  }

  /**
   * First viewer subscribed: start forwarding live `shell_data`, apply the
   * size, and return the ring-buffer dump so the caller can emit `shell_replay`
   * (only when the broker requested it). Returns `null` for an unknown shell.
   */
  attach(shellId: string, cols: number, rows: number): string | null {
    const entry = this.shells.get(shellId)
    if (!entry) return null
    entry.attached = true
    this.resize(shellId, cols, rows)
    return entry.ring.dump()
  }

  /** Last viewer left: stop forwarding live `shell_data` (PTY keeps running). */
  detach(shellId: string): void {
    const entry = this.shells.get(shellId)
    if (entry) entry.attached = false
  }

  /**
   * Kill the PTY. The actual roster removal happens via the `onExit` callback
   * fired by the process exit -- this just signals it. No-op for unknown.
   */
  kill(shellId: string, signal: NodeJS.Signals = 'SIGHUP'): void {
    this.shells.get(shellId)?.proc.kill(signal)
  }

  /** Kill every live shell (sentinel shutdown). */
  killAll(signal: NodeJS.Signals = 'SIGHUP'): void {
    for (const id of [...this.shells.keys()]) this.kill(id, signal)
  }

  /**
   * Return the shellIds that produced output since the last call, clearing
   * their dirty flags. The index.ts coalescer calls this on a ~250ms timer and
   * emits one `shell_activity` per dirty shell (plan 4.3) -- a cheap blink that
   * needs no byte subscription.
   */
  drainActivity(): string[] {
    const dirty: string[] = []
    for (const entry of this.shells.values()) {
      if (entry.activityDirty) {
        entry.activityDirty = false
        dirty.push(entry.shellId)
      }
    }
    return dirty
  }
}

function toInfo(e: ShellEntry): ShellInfo {
  return {
    shellId: e.shellId,
    projectUri: e.projectUri,
    path: e.path,
    title: e.title,
    createdBy: e.createdBy ?? '',
    createdAt: e.createdAt,
  }
}
