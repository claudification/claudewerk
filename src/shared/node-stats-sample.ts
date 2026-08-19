/**
 * The COLLECTOR behind the node-stats contract.
 *
 * `node-stats.ts` owns the shape, the cadence and the validation. This owns
 * filling it in, and it is shared for the same reason: a sentinel that measured
 * CPU one way and a reporter that measured it another would produce two
 * incomparable numbers under one field name, which is worse than having no
 * number at all.
 *
 * Node-only (`node:os` + `node:fs`). Kept out of `node-stats.ts` so the contract
 * module stays runtime-free and safe for the web bundle to import.
 */

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
 * Disk usage for the volume `dir` lives on, via `statfs(2)`.
 *
 * NOT `df`. This runs every 5s on every node forever -- forking a process for it
 * is ~17k spawns per node per day to read three numbers the kernel will hand
 * over in one syscall. `node:fs.statfsSync` is plain Node (no Bun global), so it
 * satisfies the same `web/tsconfig` constraint that ruled out `Bun.spawnSync`,
 * without the fork.
 *
 * `bavail` (free to an unprivileged user) rather than `bfree`: the reserved
 * blocks root can still write into are not space this agent can use, and a disk
 * meter that says 5% free when every write fails is a broken meter.
 *
 * Null when statfs is unavailable or nonsensical -- callers fall back to a
 * zeroed disk with the mount they asked about, which validates and renders as
 * "unknown" rather than blocking the whole frame.
 */
function readDisk(dir: string): (UsedTotal & { mount: string }) | null {
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
