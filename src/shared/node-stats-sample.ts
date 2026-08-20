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

import { arch, cpus, freemem, hostname, loadavg, platform, totalmem, uptime } from 'node:os'
import type { MachineStats, NodeIdentity, NodeStatsReport, NodeStatsSender, SentinelNodeExtras } from './node-stats'
import { readDisk } from './node-stats-disk'
import { readVolumes } from './node-stats-volumes'

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
 * The shortest summed-CPU-time window this will call a measurement, in the
 * milliseconds `os.cpus()` reports.
 *
 * Below it there is no reading to take, only quantization: both platforms
 * account CPU time in 1/100s ticks, so a window of one tick can only ever come
 * out as 0% or 100% depending on which column it landed in. That is exactly what
 * the first tick after construction was shipping (`[0, 0, 100, 0, ...]` over ten
 * cold starts on a box that was actually at ~40%).
 *
 * 100ms is ten ticks -- coarse, but a REAL fraction -- and it is 50x below the
 * smallest window production ever hands over: one 5s cadence on a single core.
 * No genuine tick can fall under it.
 */
export const CPU_SAMPLE_FLOOR_MS = 100

/**
 * Whole-box utilization between two cumulative readings, 0-100, or UNDEFINED
 * when the two readings are too close together to divide.
 *
 * Undefined rather than 0: a box that was idle and a box nobody measured are not
 * the same fact, and 0 is the one that a meter paints green and a sparkline files
 * away for five minutes. Everything downstream already knows how to render an
 * absent percentage -- see `MachineStats.cpuPercent`.
 */
export function cpuPercentFromDelta(prev: CpuTotals, next: CpuTotals): number | undefined {
  const totalDelta = next.total - prev.total
  if (totalDelta < CPU_SAMPLE_FLOOR_MS) return undefined
  const idleDelta = next.idle - prev.idle
  const busy = ((totalDelta - idleDelta) / totalDelta) * 100
  return Math.min(100, Math.max(0, Math.round(busy * 10) / 10))
}

// THE DISK READERS MOVED, and every consumer still imports them from here.
// Only the four with callers outside `node-stats-disk.ts` are re-exported --
// `readDisk` and `parseDfLine` are used by this file and by the volume collector
// respectively, and a re-export nobody imports is dead vocabulary.
// `node-stats-disk.ts` is a split for SIZE plus one structural reason: the
// per-volume collector needs the same primitives, and a module both this file
// and `node-stats-volumes.ts` import is the only way to have one definition of
// `usedBytes` without a cycle. Same functions, same contract, one new file.
export { parseDfOutput, readDiskViaDf, readDiskViaStatfs, usedFromAvailable } from './node-stats-disk'

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
 *
 * THE FIRST `sample()` CARRIES NO CPU. `prev` is seeded here, microseconds
 * before the reporter's immediate first frame, so that frame's delta spans
 * roughly nothing -- and `cpuPercentFromDelta` says so instead of inventing a
 * number. Every other fact on that frame is a point-in-time reading and is
 * perfectly good, which is why the immediate emit stays.
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
      const disk = readDisk(dir)
      // Every mount, beside the one `disk` names -- and ABSENT, never `[]`, when
      // the mount table could not be read at all. `readVolumes` forks nothing on
      // the common tick; it re-reads a cached mount list through the same
      // statfs-then-df reader `disk` just used.
      const volumes = readVolumes()
      return {
        // OMITTED, not zeroed, when there was no window -- the key is absent from
        // the wire exactly as `sentinel` is on a reporter frame.
        ...(cpuPercent !== undefined ? { cpuPercent } : {}),
        load: { one, five, fifteen, cores: Math.max(1, cpus().length) },
        memory: { usedBytes: total - freemem(), totalBytes: total },
        disk,
        ...(volumes.length > 0 ? { volumes } : {}),
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
