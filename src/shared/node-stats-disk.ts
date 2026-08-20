/**
 * THE DISK READERS -- one definition of "used", two ways to get it.
 *
 * Split out of `node-stats-sample.ts` for size, exactly as `node-stats-checks.ts`
 * was split out of `node-stats.ts`: same contract, its own file. Everything a
 * consumer imported from the sampler is still re-exported there, so no call site
 * moved.
 *
 * It lives below the sampler rather than beside it because a SECOND reader now
 * needs the same primitives -- `node-stats-volumes.ts` reads per-mount disk and
 * must compute "used" with the one function that already defines it, not with a
 * copy of the arithmetic. The dependency runs one way: sampler and volumes both
 * import this; this imports neither.
 *
 * Node-only (`node:fs` + a `df` fallback via `node:child_process`).
 */

import { execFileSync } from 'node:child_process'
import { statfsSync } from 'node:fs'
import type { UsedTotal } from './node-stats'

/** A volume's two numbers plus the path they were read at. */
export type DiskReading = UsedTotal & { mount: string }

/**
 * THE definition of `usedBytes`, and the only place it is computed.
 *
 * `total - available`, where available is what an UNPRIVILEGED writer can still
 * use: `statfs.bavail`, or df's `Available` column. The root-reserved blocks
 * therefore count as USED, because "space this agent can actually write" is the
 * number a disk meter should show -- one that says 5% free while every write
 * fails is a broken meter.
 *
 * df's own `Used` column (field 3) is the OTHER definition: it excludes the
 * reserve, so it reads low by ~5% of a default ext4 and by 38 GB on the APFS
 * volume this was caught on. The fallback used to take it, which made the one
 * node that needs the fallback -- the 30TB Synology -- read systematically low
 * against every other node on the wall. Never field 3.
 *
 * Null on a volume that reports no blocks at all: a pseudo-filesystem is not a
 * disk, and 0/0 renders as "unknown" rather than as an empty drive.
 */
export function usedFromAvailable(totalBytes: number, availBytes: number): UsedTotal | null {
  if (!Number.isFinite(totalBytes) || !Number.isFinite(availBytes) || totalBytes <= 0) return null
  return { usedBytes: Math.max(0, totalBytes - availBytes), totalBytes }
}

/**
 * Parse ONE `df -Pk` data line into used/total bytes plus df's own mount point.
 *
 * POSIX `-P` output is one header line and one data line per filesystem; the
 * blocks are 1 KiB. Long device names wrap in the non-`-P` form, which is
 * exactly why `-P` is not optional here. Null on anything unexpected -- a
 * missing disk field is honest, a fabricated zero is not.
 *
 * `usedBytes` comes from fields 2 and 4 via `usedFromAvailable`, NOT from df's
 * field 3. Both df callers -- the single-volume fallback and the whole-mount-table
 * enumeration -- go through this one line parser, so there is one place that can
 * pick the wrong column and it does not.
 */
export function parseDfLine(line: string): DiskReading | null {
  const fields = line.trim().split(/\s+/)
  // filesystem, 1024-blocks, used, available, capacity, mounted-on
  if (fields.length < 6) return null
  const volume = usedFromAvailable(Number(fields[1]) * 1024, Number(fields[3]) * 1024)
  const mount = fields.slice(5).join(' ')
  if (!volume || mount.length === 0) return null
  return { ...volume, mount }
}

/**
 * Parse `df -Pk <dir>` output -- header plus exactly one filesystem.
 *
 * The `mount` here is df's own answer, which is a strictly better fact than the
 * collector can otherwise get -- but it is NOT what ships on the wire; see
 * `readDisk` for why the contract field means the directory measured.
 */
export function parseDfOutput(stdout: string): DiskReading | null {
  const lines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
  if (lines.length < 2) return null
  return parseDfLine(lines[lines.length - 1])
}

/**
 * Disk usage via `statfs(2)`. The FAST PATH: this runs every 5s on every node
 * forever, and forking `df` for it is ~17k process spawns per node per day to
 * read three numbers the kernel hands over in one syscall.
 *
 * `bavail` (free to an unprivileged user) rather than `bfree`: the reserved
 * blocks root can still write into are not space this agent can use. That is
 * `usedFromAvailable`, the one definition both readers share.
 *
 * Returns null when statfs cannot describe the volume -- see `readDiskViaDf`.
 *
 * Exported for the test that runs one volume through BOTH readers; production
 * goes through `readDisk`.
 */
export function readDiskViaStatfs(dir: string): DiskReading | null {
  try {
    const fs = statfsSync(dir)
    const blockSize = Number(fs.bsize)
    const volume = usedFromAvailable(Number(fs.blocks) * blockSize, Number(fs.bavail) * blockSize)
    return volume ? { ...volume, mount: dir } : null
  } catch {
    return null
  }
}

/**
 * The FALLBACK, for volumes `statfs` cannot describe.
 *
 * 32-bit `statfs` returns EOVERFLOW when a filesystem has more than 2^32
 * blocks, and a big NAS array crosses that easily: the Synology `/volume1` that
 * caught this has 7,492,117,464 of them, so the reporter shipped disk 0/0 for a
 * 30TB array (2026-08-19). `df` reads the same numbers through a wider
 * interface, so it answers where the syscall cannot.
 *
 * `node:child_process`, not `Bun.spawnSync`: `web/tsconfig.json` typechecks all
 * of `src/shared` with no Bun globals. The fork cost is fine HERE because this
 * only runs for volumes that failed the syscall, not on the common tick.
 *
 * Exported for the test that runs one volume through BOTH readers; production
 * goes through `readDisk`.
 */
export function readDiskViaDf(dir: string): DiskReading | null {
  try {
    const stdout = execFileSync('df', ['-Pk', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const volume = parseDfOutput(stdout)
    // df knows the real mount point and statfs cannot know it at all, so the
    // honest common answer is the DIRECTORY that was measured. Reporting df's
    // `/volume1` from the fallback while every statfs node reports the agent's
    // working directory is the same bug as two `usedBytes` under one name.
    return volume ? { ...volume, mount: dir } : null
  } catch {
    return null
  }
}

/**
 * Syscall first, `df` when it cannot answer, and the ONE place `mount` is
 * stamped so no reader can drift into a second meaning of it.
 *
 * Never null: when neither reader can describe the volume this is a zeroed disk
 * at the directory asked about, which validates and renders as "unknown"
 * rather than blocking the whole frame over one missing field.
 */
export function readDisk(dir: string): DiskReading {
  const volume = readDiskViaStatfs(dir) ?? readDiskViaDf(dir)
  return { usedBytes: volume?.usedBytes ?? 0, totalBytes: volume?.totalBytes ?? 0, mount: dir }
}
