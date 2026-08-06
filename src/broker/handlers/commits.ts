/**
 * Commit ledger subscription handler.
 *
 * A panel says how much it wants. Default is `counts` -- an id and an integer
 * per commit, enough to drive a pill on every conversation in the list. Only a
 * surface that actually renders commit rows (the Commits tab, the global
 * browser) asks for `full`, because a full row carries the message, the branch
 * and every touched path, and a phone watching fifteen conversations has no
 * reason to pay for that.
 *
 * The mode lives on the socket, so it survives per-connection and dies with it.
 */

import type { CommitSubscribeMode } from '../commit-ledger/broadcast'
import { getCommitCount } from '../commit-ledger/counts'
import { getProjectCommitStats } from '../commit-ledger/project-counts'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { DASHBOARD_ROLES, registerHandlers } from '../message-router'

const MODES: ReadonlySet<string> = new Set(['counts', 'full'])

function socketOf(ctx: HandlerContext): { commitMode?: CommitSubscribeMode } | null {
  const ws = ctx.ws as unknown as { data?: { commitMode?: CommitSubscribeMode } } | undefined
  return ws?.data ?? null
}

const commitSubscribe: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  const requested = typeof data.mode === 'string' ? data.mode : 'counts'
  const mode: CommitSubscribeMode = MODES.has(requested) ? (requested as CommitSubscribeMode) : 'counts'
  const socket = socketOf(ctx)
  if (socket) socket.commitMode = mode
  ctx.reply({ type: 'commit_subscribe_result', requestId: data.requestId, ok: true, mode })
}

/** Seed a freshly-mounted pill without waiting for the next commit. */
const commitCountRequest: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  const conversationId = typeof data.conversationId === 'string' ? data.conversationId : ''
  if (!conversationId) return
  const conv = ctx.conversations.getConversation(conversationId)
  // The ledger outlives its conversations, but a count for one the caller
  // cannot read is still a disclosure -- gate on the live record's project.
  if (!conv) return
  ctx.requirePermission('chat:read', conv.project)
  ctx.reply({
    type: 'commit_count',
    conversationId,
    commitCount: getCommitCount(conversationId),
  })
}

/** Seed a freshly-opened PLACE card. Reads the in-memory project map -- no
 *  query, no scan -- so a hover costs nothing beyond the round trip. */
const projectCommitStatsRequest: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  const project = typeof data.project === 'string' ? data.project.trim() : ''
  if (!project) return
  ctx.requirePermission('chat:read', project)
  ctx.reply({ type: 'project_commit_stats', project, stats: getProjectCommitStats(project) })
}

export function registerCommitHandlers(): void {
  registerHandlers(
    {
      commit_subscribe: commitSubscribe,
      commit_count_request: commitCountRequest,
      project_commit_stats_request: projectCommitStatsRequest,
    },
    DASHBOARD_ROLES,
  )
}
