/**
 * Node-stats store -- the broker's in-memory view of fleet vitals.
 *
 * TWO AGENTS ON ONE BOX MUST NOT DOUBLE-COUNT THE MACHINE. That rule is
 * implemented here, once:
 *
 *   - rows are KEYED BY NODE ID       -- a sentinel and a reporter on the same
 *                                        box stay two rows, because they are
 *                                        two agents with two lifecycles
 *   - rows are LABELLED BY HOSTNAME   -- the human-readable identity
 *   - machine facts are DEDUPED PER HOST -- exactly one node per hostname is
 *                                        the machine owner (the freshest
 *                                        sample wins), so summing cpu/ram/disk
 *                                        across owners counts each box once
 *
 * In memory only, like the sentinel roster: a vitals sample older than the
 * broker process is worthless, and persisting a 5s cadence would be pure write
 * amplification.
 */

import { NODE_STATS_STALE_MS, type NodeStatsRecord } from '../shared/node-stats'

/** One machine, after dedupe. `nodeIds` lists every agent reporting this host
 *  so a UI can show "2 agents" without adding their cpu numbers together. */
export interface MachineRow {
  hostname: string
  /** The node whose sample is currently authoritative for this host. */
  ownerNodeId: string
  nodeIds: string[]
  sampledAt: number
  machine: NodeStatsRecord['machine']
}

export interface NodeStatsStore {
  /** Record a validated sample. Returns true when this node now owns its
   *  host's machine stats (the dedupe answer, computed in one place). */
  record(sample: NodeStatsRecord): boolean
  /** Drop a node (its connection closed). */
  remove(nodeId: string): boolean
  get(nodeId: string): NodeStatsRecord | undefined
  /** Every known node, freshest first. Includes stale ones -- the caller
   *  decides whether to grey them out; dropping them here would make a node
   *  vanish the instant it hiccups. */
  nodes(): NodeStatsRecord[]
  /** One row per HOST. */
  machines(): MachineRow[]
  /** Is this node the machine owner for its host right now? */
  isMachineOwner(nodeId: string): boolean
  isStale(nodeId: string, now?: number): boolean
  size(): number
  clear(): void
}

/**
 * Pick the machine owner for a group of nodes on one host: the freshest
 * sample, tie-broken by node id so the choice is stable and never flaps
 * between two nodes that sampled in the same millisecond.
 */
function pickOwner(group: NodeStatsRecord[]): NodeStatsRecord {
  let best = group[0]
  for (const candidate of group.slice(1)) {
    if (candidate.sampledAt > best.sampledAt) best = candidate
    else if (candidate.sampledAt === best.sampledAt && candidate.nodeId < best.nodeId) best = candidate
  }
  return best
}

export function createNodeStatsStore(): NodeStatsStore {
  const byNodeId = new Map<string, NodeStatsRecord>()

  function groupByHost(): Map<string, NodeStatsRecord[]> {
    const groups = new Map<string, NodeStatsRecord[]>()
    for (const record of byNodeId.values()) {
      const group = groups.get(record.hostname)
      if (group) group.push(record)
      else groups.set(record.hostname, [record])
    }
    return groups
  }

  function ownerFor(hostname: string): string | undefined {
    const group = groupByHost().get(hostname)
    return group ? pickOwner(group).nodeId : undefined
  }

  function record(sample: NodeStatsRecord): boolean {
    byNodeId.set(sample.nodeId, sample)
    return ownerFor(sample.hostname) === sample.nodeId
  }

  function machines(): MachineRow[] {
    const rows: MachineRow[] = []
    for (const [hostname, group] of groupByHost()) {
      const owner = pickOwner(group)
      rows.push({
        hostname,
        ownerNodeId: owner.nodeId,
        nodeIds: group.map(r => r.nodeId).sort(),
        sampledAt: owner.sampledAt,
        machine: owner.machine,
      })
    }
    return rows.sort((a, b) => a.hostname.localeCompare(b.hostname))
  }

  return {
    record,
    remove: nodeId => byNodeId.delete(nodeId),
    get: nodeId => byNodeId.get(nodeId),
    nodes: () => [...byNodeId.values()].sort((a, b) => b.sampledAt - a.sampledAt),
    machines,
    isMachineOwner: nodeId => {
      const existing = byNodeId.get(nodeId)
      return existing ? ownerFor(existing.hostname) === nodeId : false
    },
    isStale: (nodeId, now = Date.now()) => {
      const existing = byNodeId.get(nodeId)
      return existing ? now - existing.receivedAt > NODE_STATS_STALE_MS : true
    },
    size: () => byNodeId.size,
    clear: () => byNodeId.clear(),
  }
}

/** The process-wide store. One broker, one fleet view. */
export const nodeStatsStore = createNodeStatsStore()
