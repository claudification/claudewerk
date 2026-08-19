/**
 * The ONE ingest body for `node_stats` -- one contract, now two TRANSPORTS.
 *
 * A frame arriving on a WebSocket (`handlers/node-stats.ts`) and a frame POSTed
 * to `/api/node-stats` (`routes/node-stats-http.ts`) both land here, and here is
 * the only place that stamps identity, validates, stores and broadcasts. A
 * second ingest path that re-validates or re-stores is exactly the drift the
 * contract exists to prevent, so the transports own precisely two things each:
 * turning a credential into a `NodeStatsCredential`, and reporting the outcome
 * in their own dialect (a dropped frame vs an HTTP status).
 *
 * TRUST NOTHING FROM THE WIRE ABOUT IDENTITY. `node.nodeId` and `node.sender`
 * are STAMPED from the credential before validation runs, never read from the
 * payload. Otherwise a leaked `rpt_` could set `sender: 'sentinel'` and walk
 * straight past the contract's own extras rule, or claim a sentinel's node id
 * and overwrite its row. That stamping is what makes the shared validator's "a
 * reporter frame may not carry sentinel extras" rule enforceable rather than
 * advisory: by the time it runs, `sender` reflects the CREDENTIAL.
 */

import { type NodeStatsReport, type NodeStatsSender, validateNodeStats } from '../shared/node-stats'
import { nodeStatsStore } from './node-stats-store'

/** Who the BROKER decided this sender is, resolved from the secret it presented.
 *  Never from the payload. */
export interface NodeStatsCredential {
  nodeId: string
  sender: NodeStatsSender
}

export interface NodeStatsIngestDeps {
  log: { info(msg: string): void; debug(msg: string): void }
  broadcast(msg: Record<string, unknown>): void
  /**
   * Emit the once-per-sender "identity stamped from credential" line.
   *
   * NEITHER sender can know its broker-assigned id -- the broker resolves it
   * from the secret, and the reporter never sees the UUID the CLI printed. So a
   * wire/credential mismatch is the NORMAL case, not an anomaly, and logging it
   * per frame is 17k lines a day per node saying nothing. The LATCH lives in the
   * transport, because what "once" means differs: once per connection on a
   * socket, once per node on a stateless POST.
   */
  announceIdentity: boolean
}

export type NodeStatsIngestResult =
  | { ok: true; report: NodeStatsReport; receivedAt: number; machineOwner: boolean }
  | { ok: false; errors: string[] }

/**
 * Stamp, validate, store, broadcast. Returns the outcome instead of replying,
 * so the caller can turn it into whatever its transport says "no" with.
 */
export function ingestNodeStats(
  credential: NodeStatsCredential,
  payload: unknown,
  deps: NodeStatsIngestDeps,
): NodeStatsIngestResult {
  const wireNode = (payload as { node?: Record<string, unknown> } | null)?.node
  if (deps.announceIdentity && wireNode && wireNode.nodeId !== credential.nodeId) {
    deps.log.info(
      `[node-stats] identity stamped from credential: wire=${String(wireNode.nodeId)} ` +
        `credential=${credential.nodeId} sender=${credential.sender} (expected -- a node cannot know its own broker id)`,
    )
  }
  // A reporter claiming to BE a sentinel is a different matter, and is always
  // logged: it is the shape of an attempt to smuggle sentinel-only extras past
  // the contract's own extras rule.
  if (credential.sender === 'reporter' && wireNode?.sender === 'sentinel') {
    deps.log.info(`[node-stats] reporter ${credential.nodeId} claimed sender=sentinel -- corrected from the credential`)
  }

  const stamped = {
    ...(payload as Record<string, unknown>),
    node: { ...(wireNode ?? {}), nodeId: credential.nodeId, sender: credential.sender },
  }

  const parsed = validateNodeStats(stamped)
  if (!parsed.ok) {
    deps.log.info(
      `[node-stats] rejected node=${credential.nodeId} sender=${credential.sender} errors=[${parsed.errors.join('; ')}]`,
    )
    return { ok: false, errors: parsed.errors }
  }

  const report = parsed.report
  const receivedAt = Date.now()
  const machineOwner = nodeStatsStore.record(report, receivedAt)
  logSample(deps, report, machineOwner)

  deps.broadcast({ type: 'node_stats_update', report, receivedAt, machineOwner })
  return { ok: true, report, receivedAt, machineOwner }
}

/** LOG EVERYTHING: one structured line per accepted sample. */
function logSample(deps: NodeStatsIngestDeps, report: NodeStatsReport, machineOwner: boolean): void {
  const { node, machine } = report
  deps.log.debug(
    `[node-stats] node=${node.nodeId} sender=${node.sender} host=${node.hostname}/${node.hostId} ` +
      `cpu=${machine.cpuPercent.toFixed(1)}% load=${machine.load.one.toFixed(2)}/${machine.load.cores} ` +
      `mem=${machine.memory.usedBytes}/${machine.memory.totalBytes} ` +
      `disk=${machine.disk.usedBytes}/${machine.disk.totalBytes}@${machine.disk.mount} ` +
      `convs=${report.sentinel?.conversationCount ?? '-'} ` +
      `machineOwner=${machineOwner} nodesKnown=${nodeStatsStore.size()}`,
  )
}

/** Drop a node's row when its socket goes. A vitals row for a node that is not
 *  connected is a lie the fleet view would render as live.
 *
 *  THE HTTP PATH HAS NO SUCH EVENT -- a stateless POST has no close. An
 *  HTTP-only node's row therefore survives until the broker restarts, and goes
 *  STALE (`isNodeStatsStale`, three missed cadences) rather than vanishing. That
 *  is the documented cost of the transport, not an oversight: consumers already
 *  have to honour staleness because a live socket can go quiet too. */
export function forgetNodeStats(nodeId: string): void {
  if (nodeStatsStore.remove(nodeId)) {
    console.log(`[node-stats] dropped node=${nodeId} (disconnected) nodesKnown=${nodeStatsStore.size()}`)
  }
}
