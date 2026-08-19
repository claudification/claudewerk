/**
 * The COLLECTOR behind the node-stats contract.
 *
 * `node-stats.ts` owns the shape, the cadence and the validation. This owns
 * filling it in, and it is shared for the same reason: a sentinel that measured
 * CPU one way and a reporter that measured it another would produce two
 * incomparable numbers under one field name, which is worse than having no
 * number at all.
 *
 * Node-only (`node:os` + `node:fs`, with a `df` fallback). Kept out of
 * `node-stats.ts` so the contract
 * module stays runtime-free and safe for the web bundle to import.
 */

import { execFileSync } from 'node:child_process'
import { statfsSync } from 'node:fs'
import { arch, cpus, freemem, hostname, loadavg, platform, totalmem, uptime } from 'node:os'
import type {
  MachineStats,
  NodeIdentity,
  NodeStatsReport,
  NodeStatsSender,
  SentinelNodeExtras,
  UsedTotal,
} from './node-stats'

/** Cumulative CPU jiffies across all cores, as `node:os` reports them. */
export interface CpuTotals {
  idle: number
  total: number
}

/** Sum `os.cpus()` times into one whole-box pair. */
export function cpuTotals(
  entries: Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>,
): CpuTotals {
  let idle = 0
  let total = 0
  for (const cpu of entries) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/**
 * Whole-box utilization between two cumulative readings, 0-100.
 *
 * Returns 0 when no time has elapsed (the first sample after construction, or a
 * clock that did not move) rather than dividing by zero and shipping a NaN that
 * every downstream meter would have to special-case.
 */
export function cpuPercentFromDelta(prev: CpuTotals, next: CpuTotals): number {
  const totalDelta = next.total - prev.total
  if (totalDelta <= 0) return 0
  const idleDelta = next.idle - prev.idle
  const busy = ((totalDelta - idleDelta) / totalDelta) * 100
  return Math.min(100, Math.max(0, Math.round(busy * 10) / 10))
}

/**
 * Parse `df -Pk <dir>` output into the used/total bytes for the volume, plus
 * the mount point it was measured at.
 *
 * POSIX `-P` output is one header line and one data line per filesystem; the
 * blocks are 1 KiB. Long device names wrap in the non-`-P` form, which is
 * exactly why `-P` is not optional here. Returns null on anything unexpected --
 * a missing disk field is honest, a fabricated zero is not.
 */
export function parseDfOutput(stdout: string): (UsedTotal & { mount: string }) | null {
  const lines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
  if (lines.length < 2) return null
  const fields = lines[lines.length - 1].split(/\s+/)
  // filesystem, 1024-blocks, used, available, capacity, mounted-on
  if (fields.length < 6) return null
  const totalKb = Number(fields[1])
  const usedKb = Number(fields[2])
  const mount = fields.slice(5).join(' ')
  if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || mount.length === 0) return null
  return { usedBytes: usedKb * 1024, totalBytes: totalKb * 1024, mount }
}

/**
 * Disk usage via `statfs(2)`. The FAST PATH: this runs every 5s on every node
 * forever, and forking `df` for it is ~17k process spawns per node per day to
 * read three numbers the kernel hands over in one syscall.
 *
 * `bavail` (free to an unprivileged user) rather than `bfree`: the reserved
 * blocks root can still write into are not space this agent can use, and a disk
 * meter that says 5% free when every write fails is a broken meter.
 *
 * Returns null when statfs cannot describe the volume -- see `readDiskViaDf`.
 */
function readDiskViaStatfs(dir: string): (UsedTotal & { mount: string }) | null {
  try {
    const fs = statfsSync(dir)
    const blockSize = Number(fs.bsize)
    const totalBytes = Number(fs.blocks) * blockSize
    const availBytes = Number(fs.bavail) * blockSize
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null
    return { usedBytes: Math.max(0, totalBytes - availBytes), totalBytes, mount: dir }
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
 */
function readDiskViaDf(dir: string): (UsedTotal & { mount: string }) | null {
  try {
    const stdout = execFileSync('df', ['-Pk', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return parseDfOutput(stdout)
  } catch {
    return null
  }
}

/** Syscall first, `df` when it cannot answer. Null when neither can -- callers
 *  fall back to a zeroed disk with the mount they asked about, which validates
 *  and renders as "unknown" rather than blocking the whole frame. */
function readDisk(dir: string): (UsedTotal & { mount: string }) | null {
  return readDiskViaStatfs(dir) ?? readDiskViaDf(dir)
}

/** OS/arch label as the contract wants it: one string, e.g. `darwin/arm64`. */
export function osArchLabel(): string {
  return `${platform()}/${arch()}`
}

/**
 * A stateful machine sampler. CPU utilization is a DELTA, so the sampler holds
 * the previous cumulative reading; construct it once per sender and call
 * `sample()` on the shared `NODE_STATS_INTERVAL_MS` tick.
 *
 * `dir` is the volume to measure -- the directory the agent runs in, so a
 * sentinel on an external disk reports that disk and not `/`.
 */
export interface MachineSampler {
  sample(): MachineStats
}

export function createMachineSampler(dir: string = process.cwd()): MachineSampler {
  let prev = cpuTotals(cpus())
  return {
    sample(): MachineStats {
      const next = cpuTotals(cpus())
      const cpuPercent = cpuPercentFromDelta(prev, next)
      prev = next
      const [one, five, fifteen] = loadavg()
      const total = totalmem()
      // `freemem()` is the kernel's free-page count. On darwin that excludes
      // reclaimable cache, so this reads high versus Activity Monitor. It is
      // the only figure available identically on every platform, so both
      // senders are wrong in exactly the same way rather than differently.
      const disk = readDisk(dir) ?? { usedBytes: 0, totalBytes: 0, mount: dir }
      return {
        cpuPercent,
        load: { one, five, fifteen, cores: Math.max(1, cpus().length) },
        memory: { usedBytes: total - freemem(), totalBytes: total },
        disk,
      }
    },
  }
}

/** Everything about the sender that does not change between samples. */
export interface NodeIdentityInput {
  nodeId: string
  hostId: string
  agentVersion: string
  sender: NodeStatsSender
  /** Override the OS hostname (tests, and a reporter given an explicit label). */
  hostname?: string
}

/** Fill the identity block. `uptimeSec` is the HOST's uptime, not the process's
 *  -- an agent restart must not make the box look freshly booted. */
export function buildNodeIdentity(input: NodeIdentityInput): NodeIdentity {
  return {
    nodeId: input.nodeId,
    hostId: input.hostId,
    hostname: input.hostname ?? hostname(),
    osArch: osArchLabel(),
    agentVersion: input.agentVersion,
    uptimeSec: Math.max(0, Math.round(uptime())),
    sender: input.sender,
  }
}

/**
 * Build one frame. The SENTINEL passes `extras`; the standalone reporter passes
 * nothing and the field is absent from the wire -- not zero, absent, so
 * "no reporter data" stays distinguishable from "nothing running".
 *
 * A reporter that passes extras anyway gets them dropped here rather than
 * rejected downstream: the contract says a reporter frame has no extras, and
 * this is the one place that builds frames.
 */
export function buildNodeStatsReport(
  identity: NodeIdentity,
  machine: MachineStats,
  sampledAt: number,
  extras?: SentinelNodeExtras,
): NodeStatsReport {
  const report: NodeStatsReport = { type: 'node_stats', node: identity, machine, sampledAt }
  if (extras && identity.sender === 'sentinel') report.sentinel = extras
  return report
}
