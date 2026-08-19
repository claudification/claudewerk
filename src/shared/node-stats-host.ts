/**
 * Per-HOST views over a set of node-stats frames.
 *
 * Split out of `node-stats.ts` for size. This is where "two agents on one box
 * must not double-count the machine" is actually decided -- one place, so the
 * broker store and any consumer collapse hosts identically.
 */

import { type MachineStats, NODE_STATS_STALE_AFTER_MS, type NodeStatsReport } from './node-stats'

/** Machine facts attributed to a HOST rather than to an agent. */
export interface HostMachineRow {
  hostId: string
  hostname: string
  machine: MachineStats
  sampledAt: number
  /** Every agent reporting from this host, sorted. The row exists once; the
   *  agents on it are still enumerable. */
  nodeIds: string[]
  /** The agent whose sample won. */
  reportedBy: string
}

/**
 * Collapse a set of frames to ONE machine row per host.
 *
 * Two agents on one box each send the same cpu/mem/disk. Summing or listing
 * both double-counts the machine -- `studio` would appear twice at 99% disk and
 * the fleet total would claim twice the RAM that exists. The freshest sample per
 * `hostId` wins; ties break on the lexicographically smallest `nodeId` so the
 * result does not depend on the order frames happened to arrive.
 *
 * Per-node rows (which the wall keys by `nodeId`) are NOT collapsed by this --
 * it answers "what is this box doing", not "who is on it".
 */
export function dedupeMachineStatsByHost(reports: NodeStatsReport[]): HostMachineRow[] {
  const byHost = new Map<string, HostMachineRow>()
  for (const report of reports) {
    const { hostId, hostname, nodeId } = report.node
    const existing = byHost.get(hostId)
    if (!existing) {
      byHost.set(hostId, {
        hostId,
        hostname,
        machine: report.machine,
        sampledAt: report.sampledAt,
        nodeIds: [nodeId],
        reportedBy: nodeId,
      })
      continue
    }
    if (!existing.nodeIds.includes(nodeId)) existing.nodeIds.push(nodeId)
    const fresher = report.sampledAt > existing.sampledAt
    const tie = report.sampledAt === existing.sampledAt && nodeId < existing.reportedBy
    if (fresher || tie) {
      existing.machine = report.machine
      existing.sampledAt = report.sampledAt
      existing.hostname = hostname
      existing.reportedBy = nodeId
    }
  }
  for (const row of byHost.values()) row.nodeIds.sort()
  return [...byHost.values()].sort((a, b) => a.hostId.localeCompare(b.hostId))
}

/** True when `report` is old enough that a consumer must render it as stale
 *  (greyed, with a last-seen age) instead of as a live number. */
export function isNodeStatsStale(report: NodeStatsReport, now: number): boolean {
  return now - report.sampledAt > NODE_STATS_STALE_AFTER_MS
}
