/**
 * The ONE broker handler for `report_node_stats`.
 *
 * A sentinel frame and a standalone-reporter frame land HERE, in the same
 * function, validated by the same shared validator. There is no reporter-
 * specific ingest path -- if you find yourself adding one, the contract has
 * already drifted.
 *
 * TRUST NOTHING FROM THE WIRE ABOUT IDENTITY. `nodeId` and `kind` are stamped
 * from the CREDENTIAL that opened the socket, never read from the payload:
 * otherwise a leaked `rpt_` could claim a sentinel's node id and overwrite its
 * row. Likewise a reporter frame carrying a `sentinel` block has it stripped
 * (and logged) rather than trusted -- sentinel-only fields are absent from a
 * reporter frame by enforcement, not by good manners.
 */

import type { NodeKind, NodeStatsRecord } from '../../shared/node-stats'
import { REPORT_NODE_STATS } from '../../shared/node-stats'
import { validateNodeStats } from '../../shared/node-stats-validate'
import type { HandlerContext, MessageHandler } from '../handler-context'
import { registerHandlers, type WsRole } from '../message-router'
import { nodeStatsStore } from '../node-stats-store'

/** Roles whose credential carries `can_report_node_stats`. The router enforces
 *  the reverse direction too: a reporter connection may send NOTHING ELSE. */
export const NODE_STATS_SENDERS: WsRole[] = ['sentinel', 'reporter']

/** The authenticated identity of the socket: which node is this, really.
 *  Returns null when the socket carries no node credential at all. */
function credentialIdentity(ctx: HandlerContext): { nodeId: string; kind: NodeKind } | null {
  const reporterId = ctx.ws.data.reporterId
  if (reporterId) return { nodeId: reporterId, kind: 'reporter' }
  const sentinelId = ctx.ws.data.sentinelId
  if (sentinelId) return { nodeId: sentinelId, kind: 'sentinel' }
  return null
}

export const reportNodeStats: MessageHandler = (ctx, data) => {
  const identity = credentialIdentity(ctx)
  if (!identity) {
    ctx.log.info(`[node-stats] rejected ${REPORT_NODE_STATS}: socket carries no sentinel/reporter credential`)
    return
  }

  const parsed = validateNodeStats(data)
  if (!parsed.ok) {
    ctx.log.info(`[node-stats] rejected node=${identity.nodeId} kind=${identity.kind} reason=${parsed.error}`)
    return
  }
  const frame = parsed.value

  if (frame.nodeId !== identity.nodeId && identity.kind === 'reporter') {
    // A reporter knows its own id (the broker CLI printed it), so a mismatch is
    // either a misconfiguration or an attempt to overwrite another node's row.
    // Not fatal -- we simply believe the credential -- but never silent.
    ctx.log.info(
      `[node-stats] nodeId mismatch: wire=${frame.nodeId} credential=${identity.nodeId} kind=reporter -- using credential`,
    )
  }
  // A SENTINEL cannot know its broker-assigned `snt_` id (the broker resolves it
  // from the secret), so it sends its machineId and this stamp is expected, not
  // suspicious. The machineId still reaches the broker via sentinel_identify.

  const record: NodeStatsRecord = {
    ...frame,
    nodeId: identity.nodeId,
    kind: identity.kind,
    receivedAt: Date.now(),
  }

  if (identity.kind === 'reporter' && record.sentinel) {
    ctx.log.info(
      `[node-stats] stripped sentinel-only block from reporter frame node=${identity.nodeId} (reporters have no conversations or profiles)`,
    )
    record.sentinel = undefined
  }

  const machineOwner = nodeStatsStore.record(record)
  const mem = record.machine.memory
  const disk = record.machine.disk
  ctx.log.debug(
    `[node-stats] node=${identity.nodeId} kind=${identity.kind} host=${record.hostname} ` +
      `cpu=${record.machine.cpuPercent.toFixed(1)}% load=${record.machine.load.avg1.toFixed(2)}/${record.machine.load.cores} ` +
      `mem=${mem.usedBytes}/${mem.totalBytes} disk=${disk.usedBytes}/${disk.totalBytes}@${disk.mount} ` +
      `convs=${record.sentinel?.conversationCount ?? '-'} profiles=${record.sentinel?.profiles.length ?? '-'} ` +
      `machineOwner=${machineOwner} nodesKnown=${nodeStatsStore.size()}`,
  )

  ctx.broadcast({ type: 'node_stats_update', node: record, machineOwner })
}

/** Drop a node's row when its socket goes. A vitals row for a node that is not
 *  connected is a lie the WALL would render as live. */
export function forgetNodeStats(nodeId: string): void {
  if (nodeStatsStore.remove(nodeId)) {
    console.log(`[node-stats] dropped node=${nodeId} (disconnected) nodesKnown=${nodeStatsStore.size()}`)
  }
}

export function registerNodeStatsHandlers(): void {
  registerHandlers({ [REPORT_NODE_STATS]: reportNodeStats }, NODE_STATS_SENDERS)
}
