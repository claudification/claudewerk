/**
 * The ONE machine sampler behind `report_node_stats`. Both senders call this --
 * the sentinel does not get a richer sample than the standalone reporter, and
 * neither computes cpu percent its own way.
 *
 * CPU percent is a DELTA between consecutive `os.cpus()` readings, so the
 * sampler is stateful and must be created once per process and reused. The
 * first sample after creation has no previous reading to diff against and
 * reports 0 -- that is honest, not a placeholder: one reading of a monotonic
 * counter carries no rate.
 */

import { statfsSync } from 'node:fs'
import { arch, cpus, freemem, hostname, loadavg, platform, totalmem, uptime } from 'node:os'
import type { NodeIdentity, NodeMachineStats } from './node-stats'

interface CpuTotals {
  idle: number
  total: number
}

function readCpuTotals(): CpuTotals {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    for (const value of Object.values(cpu.times)) total += value
    idle += cpu.times.idle
  }
  return { idle, total }
}

/** Disk used/total for the volume `mount` lives on. Returns null when the
 *  platform refuses statfs (the caller reports zeros rather than dropping the
 *  whole sample -- a node with unreadable disk stats still has a live cpu). */
function readDisk(mount: string): { usedBytes: number; totalBytes: number } | null {
  try {
    const fs = statfsSync(mount)
    const blockSize = Number(fs.bsize)
    const totalBytes = Number(fs.blocks) * blockSize
    const availBytes = Number(fs.bavail) * blockSize
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null
    return { usedBytes: Math.max(0, totalBytes - availBytes), totalBytes }
  } catch {
    return null
  }
}

export interface MachineSampler {
  sample(): NodeMachineStats
}

/**
 * Create the per-process sampler. `diskMount` defaults to the process cwd, so
 * the disk figure describes the volume the agent actually runs on (the one that
 * fills up and kills it), not an arbitrary root.
 */
export function createMachineSampler(diskMount: string = process.cwd()): MachineSampler {
  let previous: CpuTotals | null = null

  function sample(): NodeMachineStats {
    const now = readCpuTotals()
    let cpuPercent = 0
    if (previous) {
      const totalDelta = now.total - previous.total
      const idleDelta = now.idle - previous.idle
      // A zero or negative delta means the counters did not advance (or wrapped
      // across a suspend). Report 0 rather than a divide-by-zero NaN.
      if (totalDelta > 0) cpuPercent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
    }
    previous = now

    const [avg1, avg5, avg15] = loadavg()
    const total = totalmem()
    const disk = readDisk(diskMount)

    return {
      cpuPercent,
      load: { avg1, avg5, avg15, cores: Math.max(1, cpus().length) },
      memory: { usedBytes: Math.max(0, total - freemem()), totalBytes: total },
      disk: { usedBytes: disk?.usedBytes ?? 0, totalBytes: disk?.totalBytes ?? 0, mount: diskMount },
    }
  }

  return { sample }
}

/** Build the identity block. `nodeId` is the caller's stable id (a sentinelId
 *  or a reporterId); everything else is read from the host. */
export function readNodeIdentity(nodeId: string, agentVersion: string): NodeIdentity {
  return {
    nodeId,
    hostname: hostname(),
    platform: `${platform()}/${arch()}`,
    agentVersion,
    uptimeSec: Math.floor(uptime()),
  }
}
