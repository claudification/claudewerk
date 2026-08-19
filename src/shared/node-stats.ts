/**
 * NODE STATS -- the ONE contract for per-node vitals.
 *
 * `report_node_stats` has exactly TWO senders:
 *   1. the SENTINEL (which also spawns, distributes credentials, runs shells)
 *   2. the standalone NODE-STATS-REPORTER (which can do nothing else)
 *
 * Same payload, same cadence, same validation, same broker handler. Neither
 * sender defines its own shape -- two definitions of one shape is exactly the
 * drift the no-duplication covenant exists to prevent. If you are about to add
 * a field for one sender only, it goes on the OPTIONAL `sentinel` block, not on
 * a second interface.
 *
 * BOUNDARIES:
 *  - PROFILE-ENV BOUNDARY (src/sentinel/sentinel-config.ts:20): profile NAMES
 *    and a utilization percent may cross to the broker. configDir, `env` and
 *    oauth tokens NEVER do -- `validateNodeStats` rebuilds the frame field by
 *    field, so a misbehaving sender cannot smuggle them past this contract.
 *  - MACHINE facts (cpu/load/mem/disk) are per HOST. SENTINEL facts
 *    (conversation count, profiles) are per SENTINEL and are OPTIONAL on the
 *    shape, absent from a reporter frame. Two agents on one box must not
 *    double-count the machine: rows are keyed by node id, labelled by hostname,
 *    and machine stats are deduped per host (see broker/node-stats-store.ts).
 *
 * This file is types + constants. Validation lives in `node-stats-validate.ts`,
 * sampling in `node-stats-sampler.ts`, the cadence runner in
 * `node-stats-reporting.ts` -- all four are the same contract, split only
 * because one file may not cross 200 lines.
 */

/** The one message type a reporter credential is allowed to send. */
export const REPORT_NODE_STATS = 'report_node_stats'

/**
 * ONE sample every 5s, for BOTH senders. Lives here, not in either sender --
 * a cadence defined twice drifts the moment one side is tuned. The sentinel
 * rides this on its already-open socket (no new connection); the broker never
 * polls for it.
 */
export const NODE_STATS_INTERVAL_MS = 5000

/** A node whose last sample is older than this is stale, not live. */
export const NODE_STATS_STALE_MS = NODE_STATS_INTERVAL_MS * 3

/** What kind of agent sent the frame. A reporter can never claim 'sentinel':
 *  the broker stamps this from the CREDENTIAL, never from the wire. */
export type NodeKind = 'sentinel' | 'reporter'

/** Who the node is. Stable across reconnects (nodeId), plus display labels. */
export interface NodeIdentity {
  /** Stable per-node id. Sentinel: its sentinelId. Reporter: its reporterId.
   *  Rows are keyed by this -- two agents on one box stay two rows. */
  nodeId: string
  /** Display label AND the machine-dedupe key. Two nodes reporting the same
   *  hostname describe ONE machine. */
  hostname: string
  /** OS/arch label, e.g. `darwin/arm64`. */
  platform: string
  /** Agent build the sample came from (git short hash or a version string). */
  agentVersion: string
  /** Host uptime in whole seconds. */
  uptimeSec: number
}

/** Load average with the core count needed to read it. `avg1 / cores > 1`
 *  means oversubscribed -- the bare number is meaningless without `cores`. */
export interface NodeLoad {
  avg1: number
  avg5: number
  avg15: number
  cores: number
}

/** A used/total byte pair. Percentages are derived at render time, never sent
 *  -- one number that can disagree with its own inputs is a bug factory. */
export interface NodeBytes {
  usedBytes: number
  totalBytes: number
}

/** Per-HOST machine facts. Deduped per hostname broker-side. */
export interface NodeMachineStats {
  /** 0-100, averaged across all cores since the previous sample. */
  cpuPercent: number
  load: NodeLoad
  memory: NodeBytes
  /** The volume the agent itself runs on, plus its mount point. */
  disk: NodeBytes & { mount: string }
}

/** Profile NAME + plan utilization. The ENTIRE broker-safe profile slice --
 *  configDir and env have no representation here by construction. */
export interface NodeProfileUtilization {
  name: string
  /** 0-100, or undefined when the profile has no usable reading. */
  utilizationPercent?: number
}

/** Sentinel-only extras. OPTIONAL on the shape and ABSENT from a reporter
 *  frame -- a reporter has no conversations and no profiles. */
export interface NodeSentinelStats {
  conversationCount: number
  profiles: NodeProfileUtilization[]
}

/** The wire frame. Both senders emit exactly this. */
export interface ReportNodeStats extends NodeIdentity {
  type: typeof REPORT_NODE_STATS
  /** ms epoch the sample was taken (sender clock). */
  sampledAt: number
  machine: NodeMachineStats
  /** Present only on a sentinel frame. */
  sentinel?: NodeSentinelStats
}

/** A validated frame plus the facts only the broker knows: which credential
 *  sent it, and when the broker saw it. */
export interface NodeStatsRecord extends ReportNodeStats {
  kind: NodeKind
  receivedAt: number
}
