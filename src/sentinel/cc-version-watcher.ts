/**
 * cc-version-watcher -- detect Claude Code daemon version / protocol changes.
 *
 * The sentinel pings the daemon control socket on boot and on a poll interval.
 * `ping` returns `{ version, proto }`; we compare against the last-seen pair
 * persisted to disk and emit one `cc_version_changed` event on every diff.
 *
 * The factory is a pure seam: ping / load / persist / emit are injected, the
 * `runOnce` method drives one full cycle, and `start` / `stop` add the timer.
 * This makes the diff logic unit-testable without a real socket or filesystem.
 *
 * LOG EVERYTHING -- every version diff logs prev/next on both axes plus the
 * observed-at timestamp; every ping failure logs the error tail. No-change
 * polls are silent except in debug.
 *
 * EVERYTHING IS A STRUCTURED MESSAGE -- `emit` carries a typed
 * `CcVersionChanged` payload; the broker handler persists + broadcasts it.
 */
import type { CcMinVersionUnmet, CcVersionChanged } from '../shared/protocol'

/** Minimum CC version required for the daemon backend (sleep/wake-stale
 *  recovery + the socket `dispatch` op both land in 2.1.142). The watcher
 *  emits `cc_min_version_unmet` when the configured default transport is
 *  `claude-daemon` AND the installed version is below this floor.
 *
 *  Bumping this: keep in sync with `docs/cc-daemon-socket-protocol.md` and
 *  any test fixtures that pin the min. The constant is exported for the
 *  unit-test seam. */
export const CC_MIN_VERSION_FOR_DAEMON = '2.1.142'

/** Parse a "X.Y.Z" semver-ish version into a comparable triple. Returns
 *  null for unparseable input. The CC version is always X.Y.Z (no prerelease
 *  / build suffixes observed across 2.1.140..2.1.150), so this is enough. */
export function parseCcVersion(v: string): [number, number, number] | null {
  const parts = v.split('.').map(s => Number.parseInt(s, 10))
  if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null
  return [parts[0], parts[1], parts[2]]
}

/** True when `installed` is strictly below `required` (semver triple compare). */
export function ccVersionBelow(installed: string, required: string): boolean {
  const a = parseCcVersion(installed)
  const b = parseCcVersion(required)
  if (!a || !b) return false // unparseable: don't fire a false-positive banner
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true
    if (a[i] > b[i]) return false
  }
  return false // equal
}

/** Last-seen pair persisted between sentinel restarts. Both null on first run. */
export interface LastSeenCcVersion {
  version: string | null
  proto: number | null
}

/** Result of a ping against the daemon control socket. */
export interface PingResult {
  version: string
  proto: number
}

export interface CcVersionWatcherOptions {
  /** Ping the control socket. Returns `null` when the daemon is unreachable. */
  ping: () => Promise<PingResult | null>
  /** Read the persisted last-seen pair (sync -- called once at start + once per cycle). */
  loadLastSeen: () => LastSeenCcVersion
  /** Persist a new last-seen pair after a diff fires. */
  persistLastSeen: (next: LastSeenCcVersion) => void
  /** Emit a `CcVersionChanged` event when a diff is observed. */
  emit: (event: CcVersionChanged) => void
  /** Emit a `CcMinVersionUnmet` event when the installed CC is below the
   *  required floor for the active default transport. Idempotent per
   *  (installedVersion, requiredVersion) -- the watcher suppresses repeat
   *  emits for the same gap. */
  emitMinUnmet?: (event: CcMinVersionUnmet) => void
  /** Returns true when the active default transport requires the daemon backend.
   *  When this returns false the watcher never fires `cc_min_version_unmet`. */
  isDaemonDefault?: () => boolean
  /** Diagnostic hook -- called on every ping failure. Pure side-channel. */
  onError?: (err: Error) => void
  /** Poll interval in ms. Default 60_000. */
  intervalMs?: number
  /** Sentinel id stamped onto every emitted event. */
  sentinelId: string
  /** Clock seam -- defaults to `Date.now`. */
  now?: () => number
  /** Override the minimum CC version -- defaults to `CC_MIN_VERSION_FOR_DAEMON`.
   *  Exposed for tests; production should rely on the default. */
  minVersionForDaemon?: string
}

export interface CcVersionWatcher {
  /** Begin polling. Idempotent. */
  start(): void
  /** Stop polling + release the timer. Idempotent. */
  stop(): void
  /** Run one cycle synchronously -- the unit-test seam. */
  runOnce(): Promise<void>
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Compute whether a ping result differs from the last-seen pair. Returns the
 * diff payload (sans `sentinelId` / `observedAt`) or `null` when they match.
 *
 * First observation after install: lastSeen.version === null AND the ping
 * succeeds -- this counts as a diff with `fromVersion: null`. Same for proto.
 */
export function diffCcVersion(
  prev: LastSeenCcVersion,
  next: PingResult,
): { fromVersion: string | null; toVersion: string; fromProto: number | null; toProto: number } | null {
  const versionChanged = prev.version !== next.version
  const protoChanged = prev.proto !== next.proto
  if (!versionChanged && !protoChanged) return null
  return {
    fromVersion: prev.version,
    toVersion: next.version,
    fromProto: prev.proto,
    toProto: next.proto,
  }
}

/**
 * Build a watcher. Pure factory: no side effects until `start()` or `runOnce()`.
 */
export function createCcVersionWatcher(opts: CcVersionWatcherOptions): CcVersionWatcher {
  const intervalMs = opts.intervalMs ?? 60_000
  const now = opts.now ?? Date.now
  const minVersion = opts.minVersionForDaemon ?? CC_MIN_VERSION_FOR_DAEMON
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  let inFlight = false
  /** Last (installed, required) pair we fired cc_min_version_unmet for. Lets
   *  the watcher stay idempotent across polls without spamming the dashboard. */
  let lastMinUnmetFor: { installed: string; required: string } | null = null

  async function runOnce(): Promise<void> {
    if (inFlight) return
    inFlight = true
    try {
      let pingResult: PingResult | null
      try {
        pingResult = await opts.ping()
      } catch (err) {
        opts.onError?.(toError(err))
        return
      }
      if (!pingResult) return // daemon unreachable -- silent skip

      // Min-version safety net (sweep P1-3 / C4). Fires when the active
      // default transport demands the daemon backend AND the installed CC
      // is below the floor. Idempotent per (installed, required) -- a
      // post-upgrade poll where the gap closes resets the suppressor so a
      // future regression re-fires.
      if (opts.emitMinUnmet && opts.isDaemonDefault?.()) {
        if (ccVersionBelow(pingResult.version, minVersion)) {
          const already = lastMinUnmetFor?.installed === pingResult.version && lastMinUnmetFor?.required === minVersion
          if (!already) {
            lastMinUnmetFor = { installed: pingResult.version, required: minVersion }
            opts.emitMinUnmet({
              type: 'cc_min_version_unmet',
              sentinelId: opts.sentinelId,
              installedVersion: pingResult.version,
              requiredVersion: minVersion,
              requiredFor: 'daemon-backend',
              observedAt: now(),
            })
          }
        } else {
          lastMinUnmetFor = null
        }
      }

      const prev = opts.loadLastSeen()
      const diff = diffCcVersion(prev, pingResult)
      if (!diff) return
      const event: CcVersionChanged = {
        type: 'cc_version_changed',
        sentinelId: opts.sentinelId,
        ...diff,
        observedAt: now(),
      }
      opts.persistLastSeen({ version: pingResult.version, proto: pingResult.proto })
      opts.emit(event)
    } finally {
      inFlight = false
    }
  }

  return {
    start(): void {
      if (running) return
      running = true
      void runOnce() // immediate cycle on start
      timer = setInterval(() => {
        void runOnce()
      }, intervalMs)
    },
    stop(): void {
      running = false
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    runOnce,
  }
}
