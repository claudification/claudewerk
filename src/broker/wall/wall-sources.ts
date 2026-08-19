/**
 * Projections from the broker's own types into THE WALL's compact wire rows,
 * plus the seed that gives the first subscriber a complete fleet picture.
 *
 * These are PROJECTIONS, not copies: a `ConversationSummary` carries ~100
 * fields and the pulse pane reads fifteen. Sending the summary would put the
 * fat conversation payload on a 2 Hz timer, which is the opposite of the point.
 */

import type { CommitRow } from '../../shared/commit-ledger'
import type { ConversationSummary } from '../../shared/protocol'
import type { WallCommitRow, WallPulseRow } from '../../shared/wall'
import { publishWallPulse, setWallSeed, wallActive } from './index'

/** A hard block is something un-fakeable holding the conversation: the broker
 *  is waiting on a human, not on the model. */
function isBlocked(s: ConversationSummary): boolean {
  return !!s.pendingAttention || !!s.pendingSpawnApproval || s.turnSummary?.category === 'blocked'
}

export function pulseRowFromSummary(s: ConversationSummary): WallPulseRow {
  return {
    id: s.id,
    project: s.project,
    title: s.title || s.agentName || s.summary || s.id.slice(0, 8),
    status: s.status,
    lastActivity: s.lastActivity,
    ...(s.lastInputAt !== undefined ? { lastInputAt: s.lastInputAt } : {}),
    ...(s.stats?.totalCostUsd !== undefined ? { costUsd: s.stats.totalCostUsd } : {}),
    ...(s.autocompactPct !== undefined ? { contextPct: s.autocompactPct } : {}),
    ...(s.hostSentinelAlias || s.hostSentinelId ? { host: s.hostSentinelAlias ?? s.hostSentinelId } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.liveStatus?.state ? { liveStatus: s.liveStatus.state } : {}),
    ...(s.turnSummary?.detail ? { classified: s.turnSummary.detail } : {}),
    // Machine-dispatched provenance comes from the launch tag the agent cannot
    // set for itself -- never from anything it self-reports.
    ...(s.epic || s.nightshift ? { managed: true } : {}),
    ...(isBlocked(s) ? { blocked: true } : {}),
  }
}

export function wallCommitFromRow(c: CommitRow): WallCommitRow {
  return {
    hash: c.hash,
    shortHash: c.shortHash,
    repoUri: c.repoUri,
    repoName: c.repoName,
    branch: c.branch,
    subject: c.subject,
    authorName: c.authorName,
    insertions: c.insertions,
    deletions: c.deletions,
    fileCount: c.fileCount,
    ...(c.conversationId ? { conversationId: c.conversationId } : {}),
    ...(c.conversationName ? { conversationName: c.conversationName } : {}),
    committedAt: c.committedAt,
  }
}

/** Push one conversation onto the wall. No-op while nobody is watching, and the
 *  projection itself is skipped in that case -- building a row for an empty
 *  audience is still work. */
export function pushWallPulse(summary: ConversationSummary): void {
  if (!wallActive()) return
  publishWallPulse(pulseRowFromSummary(summary))
}

/**
 * Install the seed. Nothing accumulates into the hub while it is unwatched, so
 * the 0->1 subscriber transition asks the conversation store for the current
 * fleet once and fills the snapshot from it. Without this, a freshly opened
 * wall would show an empty pulse pane until conversations happened to change.
 *
 * Event sections (commits, card moves) are deliberately NOT seeded: they are a
 * river, not a state, and their panes fetch their own history.
 */
export function attachWallSources(getSummaries: () => ConversationSummary[]): void {
  setWallSeed(() => {
    const summaries = getSummaries()
    for (const s of summaries) publishWallPulse(pulseRowFromSummary(s))
    console.log(`[wall] seed: ${summaries.length} conversation(s) into the first snapshot`)
  })
}
