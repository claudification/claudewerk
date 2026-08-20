/**
 * PER-VOLUME disk -- the resolution `machine.disk` cannot have.
 *
 * `machine.disk` is ONE volume: the one the agent runs on. On a box sitting at
 * 99% that says the box is full and cannot say which disk, so the alert is a red
 * meter nobody can act on. This enumerates the mount table instead, and the
 * broker files one stats object per mount.
 *
 * ONE DEFINITION OF USED, computed once, here. Every number below comes out of
 * `usedFromAvailable` in `node-stats-disk.ts` -- the same function `machine.disk`
 * uses. The broker PROJECTS these bytes into a percentage and never recomputes
 * them a second way; `node-stats-disk-used-two-definitions` is the card that
 * exists because two paths once did.
 *
 * THE ENUMERATION IS CACHED, THE READINGS ARE NOT. Listing mounts means forking
 * `df`, and the 5s tick is the one path that must never fork (~17k spawns per
 * node per day). So the mount LIST is refreshed every
 * `VOLUME_MOUNT_REFRESH_MS` -- mounting a disk is a human-scale event -- while
 * each tick re-reads every cached mount through the ordinary
 * statfs-then-df reader. A newly plugged-in disk therefore appears within five
 * minutes, not within five seconds, which is the trade this cadence is worth.
 */

import { execFileSync } from 'node:child_process'
import { NODE_STATS_MAX_VOLUMES, type VolumeStats } from './node-stats'
import { parseDfLine, readDiskViaDf, readDiskViaStatfs } from './node-stats-disk'

/** How long a mount list is reused before `df` is forked again. Five minutes:
 *  long enough that the fork is invisible next to the 5s tick, short enough that
 *  plugging a disk in shows up while you are still standing at the machine. */
export const VOLUME_MOUNT_REFRESH_MS = 5 * 60_000

/**
 * Mounts whose PATH IS DISPOSABLE.
 *
 * `name` in `stat_objects` is the mount path and an object row is forever, so a
 * mount whose path carries a timestamp or a UUID never produces a series -- it
 * produces a NEW series every time it appears, and an object table that grows
 * without bound. That is what this list is for, and the only thing it is for.
 *
 * - `/Volumes/.timemachine` and `/Volumes/com.apple.TimeMachine.localsnapshots`
 *   -- one mount per backup snapshot, path = UUID + timestamp, hourly forever.
 * - `/private/var/folders` -- per-process temp mounts (app wrappers), path = UUID.
 * - `/System/Volumes/Data/home` -- autofs, reporting no blocks at all.
 * - `/Library/Developer/CoreSimulator` -- read-only runtime images, ~98% full by
 *   construction and a new path per Xcode runtime. A permanently red meter for a
 *   volume nobody can free space on is the noise this card removes, not the signal.
 * - `/snap` -- the same class on Linux: one read-only squashfs per snap revision,
 *   always 100%.
 */
export const EPHEMERAL_MOUNT_PREFIXES = [
  '/Volumes/.timemachine',
  '/Volumes/com.apple.TimeMachine.localsnapshots',
  '/private/var/folders',
  '/System/Volumes/Data/home',
  '/Library/Developer/CoreSimulator',
  '/snap',
] as const

/**
 * Mounts that ARE NOT DISKS.
 *
 * A kernel-backed filesystem has blocks and a capacity and will happily report
 * 100%, but there is no disk under it and nothing to free: darwin's `devfs` is
 * 252 KB and permanently full, and Linux's `/run` and `/dev/shm` are RAM. Left
 * in, the fullest-first ordering hands the top of the list to a filesystem that
 * cannot be the answer to "which disk is at 99%".
 *
 * Kept separate from the list above because the reason is different, and a
 * future entry belongs under whichever reason actually applies to it.
 */
export const PSEUDO_MOUNT_PREFIXES = ['/dev', '/proc', '/sys', '/run'] as const

/** True when `mount` is `prefix` or lives under it. Segment-aware on purpose:
 *  a plain `startsWith('/dev')` would also swallow a real `/devdata` volume. */
function isUnder(mount: string, prefix: string): boolean {
  return mount === prefix || mount.startsWith(`${prefix}/`)
}

/** False for a mount that is disposable or is not a disk -- see both lists. */
export function isReportableMount(mount: string): boolean {
  return ![...EPHEMERAL_MOUNT_PREFIXES, ...PSEUDO_MOUNT_PREFIXES].some(prefix => isUnder(mount, prefix))
}

/** Parse the whole `df -Pk` table. Unparseable lines are SKIPPED rather than
 *  failing the sweep: one weird row in a mount table must not cost every other
 *  volume its series. */
export function parseDfMounts(stdout: string): VolumeStats[] {
  const lines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
  const volumes: VolumeStats[] = []
  for (const line of lines.slice(1)) {
    const reading = parseDfLine(line)
    if (reading) volumes.push(reading)
  }
  return volumes
}

/**
 * Which of the mount table's rows are worth a series.
 *
 * THREE RULES, IN ORDER:
 *
 * 1. Disposable paths are dropped (`isReportableMount`). Pseudo-filesystems with
 *    no blocks are already gone -- `usedFromAvailable` returned null for them.
 *
 * 2. Rows with IDENTICAL `(totalBytes, usedBytes)` are ONE store, and only the
 *    shortest path survives. This is not cosmetic: an APFS container's volumes
 *    all report the container's free space, so `/`, `/System/Volumes/Data`,
 *    `/System/Volumes/VM`, `/Preboot` and `/Update` produce five copies of one
 *    number under the one definition of used. Five series that must always agree
 *    is five chances for them to disagree. `/` wins because it is the path a
 *    human would name.
 *
 * 3. Fullest first, then a hard `cap`. The cap is a backstop against a
 *    pathological mount table, not a routine trim (a loaded Mac yields ~8 rows
 *    after rules 1 and 2), and it keeps the FULLEST because "which disk is at
 *    99%" is the question this whole card exists to answer.
 */
export function selectVolumes(readings: VolumeStats[], cap: number = NODE_STATS_MAX_VOLUMES): VolumeStats[] {
  const byStore = new Map<string, VolumeStats>()
  for (const volume of readings) {
    if (!isReportableMount(volume.mount)) continue
    const key = `${volume.totalBytes}\x1f${volume.usedBytes}`
    const kept = byStore.get(key)
    if (!kept || volume.mount.length < kept.mount.length) byStore.set(key, volume)
  }
  return [...byStore.values()].sort((a, b) => b.usedBytes / b.totalBytes - a.usedBytes / a.totalBytes).slice(0, cap)
}

/** The cached mount list. Module state on purpose: one collector per process,
 *  and the whole point is that consecutive ticks share it. */
let mountCache: { at: number; mounts: string[] } | null = null

/** Enumerate (or reuse) the mount paths worth reporting. A `df` that fails --
 *  no such binary, a container with no mount table -- yields NO volumes, which
 *  the frame then omits rather than claiming a disk it could not read. */
function enumerateMounts(now: number): string[] {
  if (mountCache && now - mountCache.at < VOLUME_MOUNT_REFRESH_MS) return mountCache.mounts
  let mounts: string[] = []
  try {
    const stdout = execFileSync('df', ['-Pk'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    mounts = selectVolumes(parseDfMounts(stdout)).map(volume => volume.mount)
  } catch {
    mounts = []
  }
  mountCache = { at: now, mounts }
  return mounts
}

/**
 * One reading per reportable mount, taken NOW.
 *
 * Same reader as `machine.disk`: statfs, then `df` for the volumes the syscall
 * cannot describe (the 30TB array that EOVERFLOWs is precisely a volume worth
 * naming separately). A mount that has since been unmounted reads null and is
 * simply absent from this tick -- its series stops rather than flatlining at 0.
 */
export function readVolumes(now: number = Date.now()): VolumeStats[] {
  const volumes: VolumeStats[] = []
  for (const mount of enumerateMounts(now)) {
    const reading = readDiskViaStatfs(mount) ?? readDiskViaDf(mount)
    if (reading) volumes.push({ usedBytes: reading.usedBytes, totalBytes: reading.totalBytes, mount })
  }
  return volumes
}

/** Test isolation, and the one seam that lets a suite prove the cache is real. */
export function resetVolumeMountCache(): void {
  mountCache = null
}
