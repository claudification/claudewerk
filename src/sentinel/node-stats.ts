/**
 * Sentinel side of the node-stats contract.
 *
 * The sentinel is one of the TWO senders of `report_node_stats`. It defines NO
 * shape and NO cadence of its own: it imports both from `src/shared/node-stats*`
 * and rides the frame out over the socket it ALREADY has open to the broker.
 * No second connection, no broker-side polling.
 *
 * The only thing this file adds over the standalone reporter is the OPTIONAL
 * `sentinel` block -- the facts that are per-SENTINEL rather than per-HOST.
 *
 * PROFILE-ENV BOUNDARY (sentinel-config.ts:20): what crosses here is profile
 * NAMES and a utilization percent. `configDir`, `profile.env` and oauth tokens
 * are not read by this file and have no field to travel in.
 */

import type { NodeProfileUtilization, NodeSentinelStats } from '../shared/node-stats'
import { createNodeStatsReporter, type NodeStatsReporter } from '../shared/node-stats-reporting'
import type { ProfileUsageSnapshot } from '../shared/protocol'

/**
 * The utilization number we report per profile: the widest window the plan is
 * actually measured on. Prefer the 7-day figure (the one that ends a week), and
 * fall back to the 5-hour window when only that is present. Undefined when the
 * profile is unauthed or its last poll failed -- an absent number is honest,
 * a zero would read as "plenty of headroom".
 */
export function profileUtilization(snap: ProfileUsageSnapshot): number | undefined {
  return snap.sevenDay?.usedPercent ?? snap.fiveHour?.usedPercent
}

/** Build the broker-safe profile slice: NAME + percent, nothing else. */
export function buildProfileUtilizations(usage: ReadonlyMap<string, ProfileUsageSnapshot>): NodeProfileUtilization[] {
  const out: NodeProfileUtilization[] = []
  for (const snap of usage.values()) {
    const pct = profileUtilization(snap)
    out.push(pct === undefined ? { name: snap.profile } : { name: snap.profile, utilizationPercent: pct })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export interface SentinelNodeStatsDeps {
  /** Stable node id. The broker overrides this with the id it resolved from the
   *  `snt_` secret; the sentinel sends its machineId because it cannot know the
   *  broker-assigned one. */
  nodeId: string
  agentVersion: string
  /** Conversations this sentinel currently has running (own + adopted). */
  conversationCount(): number
  profileUsage(): ReadonlyMap<string, ProfileUsageSnapshot>
  /** Emit on the EXISTING broker socket. Returns false when it is not open --
   *  a dropped sample is logged and the cadence carries on. */
  send(frame: unknown): boolean
  log(message: string): void
}

/**
 * Start reporting on the sentinel's existing connection. Returns the reporter so
 * the caller can stop it when the socket closes.
 */
export function startSentinelNodeStats(deps: SentinelNodeStatsDeps): NodeStatsReporter {
  const reporter = createNodeStatsReporter({
    nodeId: deps.nodeId,
    agentVersion: deps.agentVersion,
    send: frame => deps.send(frame),
    sentinelExtras: (): NodeSentinelStats => ({
      conversationCount: deps.conversationCount(),
      profiles: buildProfileUtilizations(deps.profileUsage()),
    }),
    log: deps.log,
  })
  reporter.start()
  return reporter
}
