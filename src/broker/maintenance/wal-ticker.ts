/**
 * WAL TICKER -- the safety net under the nightly maintenance run.
 *
 * Every tick it looks at the size of `store.db-wal` and, if it has crossed the
 * threshold, runs `wal_checkpoint(TRUNCATE)` to fold it back into the database
 * and hand the disk space back.
 *
 * Why this exists separately from `runMaintenance`, which already checkpoints:
 *
 *   1. `runMaintenance` ABORTS AT THE FIRST FAILED STEP. On 2026-08-18 the
 *      smoketest's row-count bound failed, the run stopped, and the checkpoint
 *      never executed at all. A cleanup that only runs when everything else
 *      succeeded is not a cleanup you can rely on.
 *   2. It runs ONCE A NIGHT. The 10.4 GB WAL of 2026-08-19 was created at 05:12
 *      and carried for the following 24 hours -- ~250 MB/s of page-cache churn,
 *      a 6 GB sawtooth in container memory, 295% CPU, and 10 GB added to every
 *      backup taken in between.
 *   3. It is gated on a verified recent backup, by design. That gate protects
 *      the destructive steps; truncating a WAL is not one of them.
 *
 * The operation is cheap and safe: the observed production truncate moved
 * 10.4 GB -> 4.1 MB in 0.41s with `busy=0` and no visible stall. When readers
 * DO hold the WAL open SQLite reports `busy` and changes nothing -- there is no
 * failure mode to recover from, so a busy tick just waits for the next one.
 */

import { checkpointWal, walBytes } from './steps'

/** Matches the nightly job's cadence closely enough to catch its output, while
 *  staying frequent enough that a mid-day burst is not carried for hours. */
export const WAL_TICK_MS = 15 * 60_000

/** Below this the WAL is doing its job and a checkpoint is pure churn. SQLite's
 *  own autocheckpoint keeps steady-state traffic around a few MB; 256 MB means
 *  something unusual happened (a VACUUM, a bulk import, a long reader). */
export const WAL_THRESHOLD_BYTES = 256 * 1024 * 1024

export interface WalTickerDeps {
  cacheDir: string
  intervalMs?: number
  thresholdBytes?: number
  /** Injectable for tests; defaults to console.log. */
  log?: (msg: string) => void
  /** Injectable for tests; defaults to the real checkpoint. */
  checkpoint?: (cacheDir: string) => string
  /** Injectable for tests; defaults to stat of the -wal sidecar. */
  walSize?: (cacheDir: string) => number
}

export interface WalTicker {
  stop(): void
  /** Exposed for tests: run one tick synchronously. */
  tick(): void
}

function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function startWalTicker(deps: WalTickerDeps): WalTicker {
  const intervalMs = deps.intervalMs ?? WAL_TICK_MS
  const threshold = deps.thresholdBytes ?? WAL_THRESHOLD_BYTES
  const log = deps.log ?? ((m: string) => console.log(m))
  const checkpoint = deps.checkpoint ?? checkpointWal
  const sizeOf = deps.walSize ?? walBytes
  let ticks = 0

  function tick(): void {
    ticks++
    const before = sizeOf(deps.cacheDir)

    // Every tick says what it saw and what it decided. A ticker that only logs
    // when it acts leaves you unable to tell "healthy" from "never ran".
    if (before < threshold) {
      log(`[wal-ticker] tick=${ticks} wal=${fmtMb(before)} threshold=${fmtMb(threshold)} -- below threshold, skipping`)
      return
    }

    log(`[wal-ticker] tick=${ticks} wal=${fmtMb(before)} threshold=${fmtMb(threshold)} -- OVER, checkpointing`)
    const started = Date.now()
    try {
      const detail = checkpoint(deps.cacheDir)
      const after = sizeOf(deps.cacheDir)
      log(
        `[wal-ticker] tick=${ticks} done in ${Date.now() - started}ms -- ${detail}` +
          ` (${fmtMb(before)} -> ${fmtMb(after)}, reclaimed ${fmtMb(before - after)})`,
      )
    } catch (err) {
      // A failed checkpoint changes nothing on disk, so the next tick simply
      // tries again. Swallowing it silently is what would be dangerous.
      const after = sizeOf(deps.cacheDir)
      log(
        `[wal-ticker] tick=${ticks} FAILED after ${Date.now() - started}ms` +
          ` -- ${err instanceof Error ? err.message : String(err)} (wal still ${fmtMb(after)}, retrying next tick)`,
      )
    }
  }

  log(
    `[wal-ticker] started -- every ${Math.round(intervalMs / 60_000)}m,` +
      ` truncating store.db-wal when it exceeds ${fmtMb(threshold)} (cacheDir=${deps.cacheDir})`,
  )

  const timer = setInterval(tick, intervalMs)
  // The broker must be able to exit without waiting on a maintenance timer.
  timer.unref?.()

  return {
    tick,
    stop() {
      clearInterval(timer)
      log(`[wal-ticker] stopped after ${ticks} ticks`)
    },
  }
}
