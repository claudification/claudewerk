/**
 * Sentinel side of the node-stats contract.
 *
 * The sentinel is one of the TWO senders. It defines NO shape, NO sampler and
 * NO cadence of its own: it imports all three from `src/shared/node-stats*` and
 * rides the frame out over the socket it ALREADY has open to the broker. No
 * second connection, no broker-side polling.
 *
 * The only thing this file adds over the standalone reporter is the OPTIONAL
 * `sentinel` block -- the facts that are per-SENTINEL rather than per-HOST.
 *
 * PROFILE-ENV BOUNDARY (sentinel-config.ts): nothing profile-shaped crosses here
 * at all. This file never reads the profile registry, and the extras block has
 * exactly one field, so there is no field for a configDir / env bag / oauth
 * token to travel in. The shared validator REJECTS any other key on the block,
 * so a future edit that widens it cannot land quietly.
 */

import type { SentinelNodeExtras } from '../shared/node-stats'
import { createNodeStatsReporter, type NodeStatsReporter } from '../shared/node-stats-reporting'
import { buildNodeIdentity } from '../shared/node-stats-sample'

export interface SentinelNodeStatsDeps {
  /** Stable per-AGENT id. The broker overrides this with the id it resolved from
   *  the `snt_` secret; the sentinel sends its machineId because it cannot know
   *  the broker-assigned one. */
  nodeId: string
  /** Stable per-HOST fingerprint -- the machine dedupe key. */
  hostId: string
  agentVersion: string
  /** Conversations this sentinel currently has running (own + adopted). The
   *  ONLY sentinel-only fact on this payload -- plan utilization rides
   *  `sentinel_usage_report`, which the sentinel already sends. */
  conversationCount(): number
  /** Emit on the EXISTING broker socket. Returns false when it is not open -- a
   *  dropped sample is logged and the cadence carries on. */
  send(report: unknown): boolean
  log(message: string): void
}

/**
 * Start reporting on the sentinel's existing connection. Returns the reporter so
 * the caller can stop it when the socket closes (an un-stopped one would stack
 * a timer per reconnect).
 */
export function startSentinelNodeStats(deps: SentinelNodeStatsDeps): NodeStatsReporter {
  const reporter = createNodeStatsReporter({
    identity: buildNodeIdentity({
      nodeId: deps.nodeId,
      hostId: deps.hostId,
      agentVersion: deps.agentVersion,
      sender: 'sentinel',
    }),
    send: report => deps.send(report),
    sentinelExtras: (): SentinelNodeExtras => ({ conversationCount: deps.conversationCount() }),
    log: deps.log,
  })
  reporter.start()
  return reporter
}
