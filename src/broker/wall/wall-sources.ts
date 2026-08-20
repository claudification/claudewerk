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
import { readCardLedger } from '../card-ledger-ring'
import { seedWallHostVitals } from './host-vitals'
import { publishWallCardMoves, publishWallPlanSample, publishWallPulse, setWallSeed, wallActive } from './index'
import { readPlanSeries } from './plan-usage-series'

/** A hard block is something un-fakeable holding the conversation: the broker
 *  is waiting on a human, not on the model. */
function isBlocked(s: ConversationSummary): boolean {
  return !!s.pendingAttention || !!s.pendingSpawnApproval || s.turnSummary?.category === 'blocked'
}

/** Machine-dispatched provenance, and it comes ONLY from the launch tag the
 *  agent cannot set for itself -- never from anything it self-reports. Named
 *  alongside `isBlocked` because they are the same kind of question. */
function isManaged(s: ConversationSummary): boolean {
  return !!s.epic || !!s.nightshift
}

/** A conversation with no title still has to be identifiable in a one-line row,
 *  so the fallback walks the three other names it might have before giving up on
 *  a short id. */
function pulseTitle(s: ConversationSummary): string {
  return s.title || s.agentName || s.summary || s.id.slice(0, 8)
}

/**
 * Alias if the sentinel has one, else its raw id, else absent.
 *
 * The `||` chain (not `??`) is deliberate and is the ONE behaviour change in
 * this projection's rewrite: an EMPTY alias now falls through to the node id
 * instead of being sent as `''`. No producer emits `''` today
 * (`getDefaultSentinelAlias()` returns `string | undefined`), so nothing on the
 * wire moves -- but a blank host label was never the answer anyone wanted.
 */
function pulseHost(s: ConversationSummary): string | undefined {
  return s.hostSentinelAlias || s.hostSentinelId || undefined
}

/**
 * Drop the keys whose value came out undefined, in ONE pass.
 *
 * Every optional field on the wire row used to carry its own
 * `...(x !== undefined ? { k: x } : {})` spread, which made a flat projection
 * read as fourteen branches (cyclomatic 19) when it has none: omitting an absent
 * field is one policy applied uniformly, not a decision per field. Stated once
 * here, the projection below is what it actually is -- a field map.
 *
 * Deliberately NOT `web/src/components/spawn-dialog/daemon-launch.ts`'s
 * `compactMeta`: that one is an untyped `Record<string, string>` bag on the far
 * side of the web/broker boundary. This one preserves the row's type.
 */
function withoutUndefined<T extends object>(row: T): T {
  for (const key of Object.keys(row) as (keyof T)[]) {
    if (row[key] === undefined) delete row[key]
  }
  return row
}

/** An empty string is not a model name, a status or a classification. The row
 *  omits what it does not know rather than sending a blank column. */
function said(text: string | undefined): string | undefined {
  return text || undefined
}

/** A boolean the row carries only when it is TRUE: `false` and absent mean the
 *  same thing to every consumer, and neither is worth a key on the wire. */
function flag(on: boolean): true | undefined {
  return on || undefined
}

function pulseRowFromSummary(s: ConversationSummary): WallPulseRow {
  return withoutUndefined({
    id: s.id,
    project: s.project,
    title: pulseTitle(s),
    status: s.status,
    lastActivity: s.lastActivity,
    lastInputAt: s.lastInputAt,
    costUsd: s.stats?.totalCostUsd,
    contextPct: s.autocompactPct,
    host: pulseHost(s),
    model: said(s.model),
    liveStatus: said(s.liveStatus?.state),
    classified: said(s.turnSummary?.detail),
    managed: flag(isManaged(s)),
    blocked: flag(isBlocked(s)),
  })
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
 * the 0->1 subscriber transition asks the live sources for their current state
 * once and fills the snapshot from it. Without this, a freshly opened wall
 * would show empty panes until something happened to change.
 *
 * Three sources answer that question today:
 *   - the conversation store, for the pulse roster
 *   - `card-ledger-ring.ts`, which `board-card-change-events` built for exactly
 *     this reason ("a wall opened cold has no history"). Reading it here is
 *     what lets the wall channel replace that card's separate
 *     `card_ledger_request` round trip instead of running beside it.
 *   - `plan-usage-series.ts`, for the same reason and more sharply: S2 is a
 *     chart of the last FIVE HOURS, so a wall opened now has to be handed the
 *     five hours that happened before it opened. That series is the one thing
 *     on the wall kept while nobody is watching; see that file for why.
 *   - `node-stats-store.ts` plus the CPU ring in `host-vitals.ts`, for S1. Same
 *     reasoning as the card ledger: the vitals series exists whether or not the
 *     wall is open, so a cold wall shows five minutes of history rather than one
 *     dot per node.
 *
 * Commits are NOT seeded: unlike card moves the broker keeps no in-memory river
 * of them, and the ledger they live in is a SQLite table the commit-river pane
 * queries for itself.
 *
 * The ring serves NEWEST FIRST; the accumulator is an oldest-first append ring,
 * so the seed walks it backwards. Permission filtering is deliberately NOT done
 * here -- the seed is shared by every subscriber and each frame is filtered
 * against its own grants on the way out.
 */
export function attachWallSources(getSummaries: () => ConversationSummary[]): void {
  setWallSeed(() => {
    const summaries = getSummaries()
    for (const s of summaries) publishWallPulse(pulseRowFromSummary(s))

    const ledger = readCardLedger()
    for (let i = ledger.length - 1; i >= 0; i--) {
      const move = ledger[i]
      if (move) publishWallCardMoves([move])
    }

    // Oldest first: the accumulator's per-key series refuses an out-of-order
    // sample, so replaying newest-first would keep one point per profile.
    const plan = readPlanSeries()
    for (const sample of plan) publishWallPlanSample(sample)

    const hosts = seedWallHostVitals()
    console.log(
      `[wall] seed: ${summaries.length} conversation(s) + ${ledger.length} card move(s)` +
        ` + ${plan.length} plan sample(s) + ${hosts} node(s) into the first snapshot`,
    )
  })
}
