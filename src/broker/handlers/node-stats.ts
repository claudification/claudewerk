/**
 * The ONE broker handler for `node_stats`.
 *
 * A sentinel frame and a standalone-reporter frame land HERE, in the same
 * function, checked by the same shared validator. There is no reporter-specific
 * ingest path -- if you find yourself adding one, the contract has drifted.
 *
 * TRUST NOTHING FROM THE WIRE ABOUT IDENTITY. `node.nodeId` and `node.sender`
 * are STAMPED from the credential that opened the socket before validation
 * runs, never read from the payload. Otherwise a leaked `rpt_` could set
 * `sender: 'sentinel'` and walk straight past the contract's own extras rule,
 * or claim a sentinel's node id and overwrite its row.
 *
 * That stamping is what makes the shared validator's "a reporter frame may not
 * carry sentinel extras" rule enforceable rather than advisory: by the time it
 * runs, `sender` reflects the CREDENTIAL.
 */

import { type NodeStatsReport, type NodeStatsSender, validateNodeStats } from '../../shared/node-stats'
import type { HandlerContext, MessageHandler } from '../handler-context'
import { registerHandlers, type WsRole } from '../message-router'
import { nodeStatsStore } from '../node-stats-store'

/** The one message type a reporter credential may send. */
export const NODE_STATS_MESSAGE = 'node_stats'

/** Roles whose credential carries `can_report_node_stats`. The router enforces
 *  the reverse direction too: a reporter connection may send NOTHING ELSE. */
export const NODE_STATS_SENDERS: WsRole[] = ['sentinel', 'reporter']

/** The authenticated identity of the socket. Null when it carries no node
 *  credential at all. */
function credentialIdentity(ctx: HandlerContext): { nodeId: string; sender: NodeStatsSender } | null {
  const reporterId = ctx.ws.data.reporterId
  if (reporterId) return { nodeId: reporterId, sender: 'reporter' }
  const sentinelId = ctx.ws.data.sentinelId
  if (sentinelId) return { nodeId: sentinelId, sender: 'sentinel' }
  return null
}

export const nodeStats: MessageHandler = (ctx, data) => {
  const identity = credentialIdentity(ctx)
  if (!identity) {
    ctx.log.info(`[node-stats] rejected ${NODE_STATS_MESSAGE}: socket carries no sentinel/reporter credential`)
    return
  }

  // Stamp identity from the CREDENTIAL, then validate.
  //
  // NEITHER sender can know its broker-assigned id -- the broker resolves it
  // from the secret, and the reporter binary never sees the UUID the CLI
  // printed. So a wire/credential mismatch is the NORMAL case, not an anomaly,
  // and logging it per frame is 17k lines a day per node saying nothing. It is
  // logged ONCE per connection: enough to spot a misconfigured sender in the
  // logs, quiet enough to be worth reading.
  const wireNode = (data as { node?: Record<string, unknown> }).node
  if (!ctx.ws.data.nodeStatsIdentityLogged) {
    ctx.ws.data.nodeStatsIdentityLogged = true
    if (wireNode && wireNode.nodeId !== identity.nodeId) {
      ctx.log.info(
        `[node-stats] identity stamped from credential: wire=${String(wireNode.nodeId)} ` +
          `credential=${identity.nodeId} sender=${identity.sender} (expected -- a node cannot know its own broker id)`,
      )
    }
  }
  // A reporter claiming to BE a sentinel is a different matter, and is always
  // logged: it is the shape of an attempt to smuggle sentinel-only extras past
  // the contract's own extras rule.
  if (identity.sender === 'reporter' && wireNode?.sender === 'sentinel') {
    ctx.log.info(`[node-stats] reporter ${identity.nodeId} claimed sender=sentinel -- corrected from the credential`)
  }

  const stamped = {
    ...(data as Record<string, unknown>),
    node: { ...(wireNode ?? {}), nodeId: identity.nodeId, sender: identity.sender },
  }

  const parsed = validateNodeStats(stamped)
  if (!parsed.ok) {
    ctx.log.info(
      `[node-stats] rejected node=${identity.nodeId} sender=${identity.sender} errors=[${parsed.errors.join('; ')}]`,
    )
    return
  }

  const report = parsed.report
  const receivedAt = Date.now()
  const machineOwner = nodeStatsStore.record(report, receivedAt)
  logSample(ctx, report, machineOwner)

  ctx.broadcast({ type: 'node_stats_update', report, receivedAt, machineOwner })
}

/** LOG EVERYTHING: one structured line per accepted sample. */
function logSample(ctx: HandlerContext, report: NodeStatsReport, machineOwner: boolean): void {
  const { node, machine } = report
  ctx.log.debug(
    `[node-stats] node=${node.nodeId} sender=${node.sender} host=${node.hostname}/${node.hostId} ` +
      `cpu=${machine.cpuPercent.toFixed(1)}% load=${machine.load.one.toFixed(2)}/${machine.load.cores} ` +
      `mem=${machine.memory.usedBytes}/${machine.memory.totalBytes} ` +
      `disk=${machine.disk.usedBytes}/${machine.disk.totalBytes}@${machine.disk.mount} ` +
      `convs=${report.sentinel?.conversationCount ?? '-'} ` +
      `machineOwner=${machineOwner} nodesKnown=${nodeStatsStore.size()}`,
  )
}

/** Drop a node's row when its socket goes. A vitals row for a node that is not
 *  connected is a lie the fleet view would render as live. */
export function forgetNodeStats(nodeId: string): void {
  if (nodeStatsStore.remove(nodeId)) {
    console.log(`[node-stats] dropped node=${nodeId} (disconnected) nodesKnown=${nodeStatsStore.size()}`)
  }
}

export function registerNodeStatsHandlers(): void {
  registerHandlers({ [NODE_STATS_MESSAGE]: nodeStats }, NODE_STATS_SENDERS)
}
