/**
 * Node-stats store -- the broker's in-memory view of fleet vitals.
 *
 * TWO AGENTS ON ONE BOX MUST NOT DOUBLE-COUNT THE MACHINE. This store does NOT
 * re-implement that rule: it keeps one row per NODE and delegates the host
 * collapse to `dedupeMachineStatsByHost` in the shared contract, which is the
 * one place that decides it. Rows are keyed by `nodeId`, labelled by `hostname`,
 * and deduped by `hostId` -- hostname is a label, not a key, because two
 * networks can and do produce two `studio`s.
 *
 * In memory only, like the sentinel roster: a vitals sample older than the
 * broker process is worthless, and persisting a 5s cadence would be pure write
 * amplification.
 */

import {
  dedupeMachineStatsByHost,
  type HostMachineRow,
  isNodeStatsStale,
  type NodeStatsReport,
} from '../shared/node-stats'

/** A stored frame plus the one fact only the broker knows: when it arrived. */
export interface StoredNodeStats {
  report: NodeStatsReport
  receivedAt: number
}

export interface NodeStatsStore {
  /** Record a validated frame. Returns true when this node now owns its host's
   *  machine row -- the dedupe verdict, computed in one place and handed to the
   *  caller so it can ride the broadcast. */
  record(report: NodeStatsReport, receivedAt?: number): boolean
  /** Drop a node (its connection closed). */
  remove(nodeId: string): boolean
  get(nodeId: string): StoredNodeStats | undefined
  /** Every known node, freshest first. Includes stale ones -- the caller decides
   *  whether to grey them out; dropping them here would make a node vanish the
   *  instant it hiccups. */
  nodes(): StoredNodeStats[]
  /** One row per HOST. */
  machines(): HostMachineRow[]
  /** Is this node the machine owner for its host right now? */
  isMachineOwner(nodeId: string): boolean
  isStale(nodeId: string, now?: number): boolean
  size(): number
  clear(): void
}

export function createNodeStatsStore(): NodeStatsStore {
  const byNodeId = new Map<string, StoredNodeStats>()

  function reports(): NodeStatsReport[] {
    return [...byNodeId.values()].map(entry => entry.report)
  }

  function ownerFor(hostId: string): string | undefined {
    return dedupeMachineStatsByHost(reports()).find(row => row.hostId === hostId)?.reportedBy
  }

  function isMachineOwner(nodeId: string): boolean {
    const entry = byNodeId.get(nodeId)
    return entry ? ownerFor(entry.report.node.hostId) === nodeId : false
  }

  return {
    record(report, receivedAt = Date.now()) {
      byNodeId.set(report.node.nodeId, { report, receivedAt })
      return isMachineOwner(report.node.nodeId)
    },
    remove: nodeId => byNodeId.delete(nodeId),
    get: nodeId => byNodeId.get(nodeId),
    nodes: () => [...byNodeId.values()].sort((a, b) => b.report.sampledAt - a.report.sampledAt),
    machines: () => dedupeMachineStatsByHost(reports()),
    isMachineOwner,
    isStale: (nodeId, now = Date.now()) => {
      const entry = byNodeId.get(nodeId)
      return entry ? isNodeStatsStale(entry.report, now) : true
    },
    size: () => byNodeId.size,
    clear: () => byNodeId.clear(),
  }
}

/** The process-wide store. One broker, one fleet view. */
export const nodeStatsStore = createNodeStatsStore()
