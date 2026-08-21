/**
 * Commit ledger INGEST -- the machine-to-machine half of /api/commits, kept
 * apart from the read routes because it is the only one that writes, the only
 * one gated on a bearer secret rather than user grants, and the only one whose
 * input is untrusted.
 */

import type { CommitIngestPayload, CommitRow } from '../../shared/commit-ledger'
import { resolveAuth } from '../auth-routes'
import { broadcastCommitCount, broadcastCommitRecorded, broadcastProjectCommitStats } from '../commit-ledger/broadcast'
import { bumpCommitCount } from '../commit-ledger/counts'
import { CommitPayloadError, normalizeCommit } from '../commit-ledger/normalize'
import { bumpProjectCommitStats, getProjectCommitStats } from '../commit-ledger/project-counts'
import { insertCommit, isCommitLedgerReady } from '../commit-ledger/store'
import type { ConversationStore } from '../conversation-store'

/** Bearer must be an admin/sentinel-grade secret. A cookie session is NOT
 *  enough to write to the ledger: ingest is machine-to-machine. */
export function hasIngestAuth(req: Request): boolean {
  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return false
  return resolveAuth(header.slice(7)).role !== 'none'
}

export interface IngestOutcome {
  status: 200 | 202 | 400 | 500 | 503
  body: Record<string, unknown>
}

/** LOG EVERYTHING: one line per ingest with enough context to reconstruct where
 *  a commit came from without re-running anything. */
function logIngest(commit: ReturnType<typeof normalizeCommit>, inserted: boolean, superseded: number): void {
  console.log(
    `[commit-ledger] ${inserted ? 'recorded' : 'duplicate'} ${commit.shortHash} kind=${commit.kind} ` +
      `origin=${commit.origin} files=${commit.fileCount}${commit.filesTruncated ? '(truncated)' : ''} ` +
      `repo=${commit.repoUri} branch=${commit.branch} host=${commit.host} ` +
      `conv=${commit.conversationId?.slice(0, 8) ?? '-'} superseded=${superseded}`,
  )
}

/**
 * Everything that follows a commit actually landing: the counters it moves and
 * the frames it sends. Split out of `ingestCommit` because that function was
 * already at the edge and `announce` pushed it over -- and because the two
 * halves answer different questions ("did the row go in" vs "who hears about
 * it"), which is the seam worth having anyway.
 *
 * `announce` is FALSE for a git backfill. Every frame here says a commit just
 * happened; a `git log` walk inserts tens of thousands from last year, and
 * sending them would fill the COMMIT RIVER with 2025 as though it were the last
 * two minutes and hand the wall's pulse a spike that never occurred. The COUNTERS
 * still move either way -- a backfilled commit really is in that project's
 * history and the total must say so. Only the announcement is suppressed.
 */
function recordSideEffects(
  conversationStore: ConversationStore,
  enriched: ReturnType<typeof normalizeCommit> & { conversationName: string | null },
  row: CommitRow,
  announce: boolean,
): void {
  // TWO TIERS, deliberately. The count is safe for anyone who can read the
  // conversation; the full row carries host disk paths and is gated harder (see
  // commit-ledger/broadcast.ts). The first version of this shipped through an
  // unscoped broadcast -- do not collapse them back together.
  if (announce) broadcastCommitRecorded(conversationStore, row)

  // The PLACE tier. A commit with no conversation still lands in a project, so
  // this bump is OUTSIDE the conversation branch below -- a human commit must
  // move the project card too.
  for (const project of bumpProjectCommitStats(enriched)) {
    if (announce) broadcastProjectCommitStats(conversationStore, project, { ...getProjectCommitStats(project) })
  }

  if (!enriched.conversationId) return
  const next = bumpCommitCount(enriched.conversationId)
  // The count lives OUTSIDE the conversation record, so nothing in the store's
  // own mutation paths knows it changed. Without this, a cached summary keeps
  // serving the pre-commit number to every `conversations_list` -- i.e. correct
  // while you stay connected (the frame below patches the client) and stale the
  // moment you reload.
  conversationStore.invalidateSummaryFor(enriched.conversationId)
  if (announce) broadcastCommitCount(conversationStore, enriched.conversationId, enriched.repoUri, next)
}

export function ingestCommit(conversationStore: ConversationStore, payload: CommitIngestPayload): IngestOutcome {
  if (!isCommitLedgerReady()) return { status: 503, body: { error: 'Ledger unavailable' } }

  let commit: ReturnType<typeof normalizeCommit>
  try {
    commit = normalizeCommit(payload, Date.now())
  } catch (err) {
    if (err instanceof CommitPayloadError) return { status: 400, body: { error: err.message } }
    throw err
  }

  try {
    // Trust the broker's own registry over the hook for anything the broker
    // already knows: the hook can only report what its env happened to carry.
    const conv = commit.conversationId ? conversationStore.getConversation(commit.conversationId) : undefined
    const profile = conv?.resolvedProfile ?? null
    const enriched = { ...commit, conversationName: commit.conversationName ?? conv?.agentName ?? null }
    const result = insertCommit(enriched, profile)
    logIngest(commit, result.inserted, result.supersededCount)

    if (result.inserted) {
      const row = { ...enriched, id: result.id, profile, supersededBy: null } as CommitRow
      recordSideEffects(conversationStore, enriched, row, !payload.backfill)
    }
    return {
      status: result.inserted ? 202 : 200,
      body: { ok: true, id: result.id, duplicate: !result.inserted },
    }
  } catch (err) {
    console.error('[commit-ledger] ingest failed:', err)
    return { status: 500, body: { error: 'Ingest failed' } }
  }
}
