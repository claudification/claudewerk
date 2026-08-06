/**
 * Per-conversation commit counts.
 *
 * The count lives in an in-memory map, NOT as a column on `conversations`:
 * conversations and commits are separate databases so there is no join to
 * denormalize from, and a hand-maintained column would drift the first time a
 * row landed out of band. One `GROUP BY` at boot is authoritative and cheap,
 * and every ingest bumps it -- so the number can never disagree with the table
 * it came from for longer than a restart.
 *
 * Superseded rows (an `--amend` replaced them) are excluded, matching what the
 * list endpoints show by default: the pill and the list agree.
 */

import { commitLedgerDb, isCommitLedgerReady } from './store'

let counts = new Map<string, number>()

export function rebuildCommitCounts(): number {
  counts = new Map()
  if (!isCommitLedgerReady()) return 0
  const rows = commitLedgerDb()
    .prepare(
      `SELECT conversation_id AS id, COUNT(*) AS n FROM commits
       WHERE conversation_id IS NOT NULL AND superseded_by IS NULL
       GROUP BY conversation_id`,
    )
    .all() as Array<{ id: string; n: number }>
  for (const row of rows) counts.set(row.id, row.n)
  return rows.length
}

export function bumpCommitCount(conversationId: string | null): number {
  if (!conversationId) return 0
  const next = (counts.get(conversationId) ?? 0) + 1
  counts.set(conversationId, next)
  return next
}

export function getCommitCount(conversationId: string): number {
  return counts.get(conversationId) ?? 0
}

/** Test seam: drop the cache so a suite starts from a known state. */
export function resetCommitCounts(): void {
  counts = new Map()
}
