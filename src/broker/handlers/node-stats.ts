/**
 * The WEBSOCKET transport for `node_stats`.
 *
 * A sentinel frame and a standalone-reporter frame land in the same place, but
 * that place is no longer this file: the stamping, validation, storage and
 * broadcast live in `node-stats-ingest.ts`, which the HTTP ingest route calls
 * too. One contract, two transports, ONE body -- if you find yourself adding
 * ingest logic here, it belongs there instead.
 *
 * What is genuinely WS-only and stays: resolving the credential off `ws.data`,
 * and the once-per-CONNECTION latch on the identity-stamp log line.
 */

import { NODE_STATS_MESSAGE, type NodeStatsSender } from '../../shared/node-stats'
import type { HandlerContext, MessageHandler } from '../handler-context'
import { registerHandlers, type WsRole } from '../message-router'
import { ingestNodeStats, type NodeStatsCredential } from '../node-stats-ingest'

// The wire message name comes from the CONTRACT. Re-exported because the router
// registration below and the capability allowlist must name the same string,
// and two hand-typed literals is one typo away from a node reporting into the
// void.
export { NODE_STATS_MESSAGE } from '../../shared/node-stats'
export { forgetNodeStats } from '../node-stats-ingest'

/** Roles whose credential carries `can_report_node_stats`. The router enforces
 *  the reverse direction too: a reporter connection may send NOTHING ELSE. */
export const NODE_STATS_SENDERS: WsRole[] = ['sentinel', 'reporter']

/** The authenticated identity of the socket. Null when it carries no node
 *  credential at all. */
function credentialIdentity(ctx: HandlerContext): NodeStatsCredential | null {
  const reporterId = ctx.ws.data.reporterId
  if (reporterId) return { nodeId: reporterId, sender: 'reporter' satisfies NodeStatsSender }
  const sentinelId = ctx.ws.data.sentinelId
  if (sentinelId) return { nodeId: sentinelId, sender: 'sentinel' satisfies NodeStatsSender }
  return null
}

export const nodeStats: MessageHandler = (ctx, data) => {
  const credential = credentialIdentity(ctx)
  if (!credential) {
    ctx.log.info(`[node-stats] rejected ${NODE_STATS_MESSAGE}: socket carries no sentinel/reporter credential`)
    return
  }

  // ONCE PER CONNECTION, not once per frame -- see the deps doc in the core.
  const announceIdentity = !ctx.ws.data.nodeStatsIdentityLogged
  if (announceIdentity) ctx.ws.data.nodeStatsIdentityLogged = true

  ingestNodeStats(credential, data, {
    log: ctx.log,
    broadcast: msg => ctx.broadcast(msg),
    announceIdentity,
  })
}

export function registerNodeStatsHandlers(): void {
  registerHandlers({ [NODE_STATS_MESSAGE]: nodeStats }, NODE_STATS_SENDERS)
}
