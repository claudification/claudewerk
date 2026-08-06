/**
 * Per-PROJECT commit aggregates -- the place-scoped twin of counts.ts.
 *
 * `commits` means two different things depending on scope: on a conversation it
 * answers "what did this agent land?"; on a project it answers "what has ever
 * landed here, by anyone?". Two questions, two maps.
 *
 * Same discipline as the per-conversation map: one `GROUP BY` at boot is
 * authoritative, every ingest bumps it, and nothing is denormalized onto a row
 * that could drift. Superseded commits (an `--amend` replaced them) are excluded,
 * matching the list endpoints.
 *
 * A commit is counted under BOTH its `repo_uri` and its `cwd_uri` when they
 * differ -- a conversation working inside a worktree carries the worktree URI
 * while the ledger's repo_uri is the main repo root, and the project list shows
 * both as projects. This mirrors the `repo_uri OR cwd_uri` match in query.ts, so
 * the card's total and the project's own commit list agree.
 */

import { projectIdentityKey } from '../../shared/project-uri'
import { commitLedgerDb, isCommitLedgerReady } from './store'

export interface ProjectCommitStats {
  total: number
  agent: number
  human: number
  /** Commits landed since local midnight. */
  today: number
  lastCommittedAt: number | null
}

interface Bucket extends ProjectCommitStats {
  /** Local midnight the `today` counter belongs to -- see dayRoll(). */
  todayStart: number
}

let buckets = new Map<string, Bucket>()

const EMPTY: ProjectCommitStats = { total: 0, agent: 0, human: 0, today: 0, lastCommittedAt: null }

function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Zero the `today` counter when the day rolled over since it was last touched.
 *  Cheaper and more honest than a re-query: after midnight, nothing has landed
 *  today until something does. */
function dayRoll(bucket: Bucket, now: number): Bucket {
  const day = startOfDay(now)
  if (bucket.todayStart !== day) {
    bucket.todayStart = day
    bucket.today = 0
  }
  return bucket
}

function ensure(key: string, now: number): Bucket {
  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = { ...EMPTY, todayStart: startOfDay(now) }
    buckets.set(key, bucket)
  }
  return bucket
}

interface Row {
  uri: string
  total: number
  agent: number
  human: number
  today: number
  last: number | null
}

function fold(row: Row, now: number): void {
  const bucket = dayRoll(ensure(projectIdentityKey(row.uri), now), now)
  bucket.total += row.total
  bucket.agent += row.agent
  bucket.human += row.human
  bucket.today += row.today
  if (row.last != null && (bucket.lastCommittedAt == null || row.last > bucket.lastCommittedAt)) {
    bucket.lastCommittedAt = row.last
  }
}

const AGGREGATES = `COUNT(*) AS total,
   COALESCE(SUM(origin = 'agent'), 0) AS agent,
   COALESCE(SUM(origin = 'human'), 0) AS human,
   COALESCE(SUM(committed_at >= $dayStart), 0) AS today,
   MAX(committed_at) AS last`

export function rebuildProjectCommitStats(now = Date.now()): number {
  buckets = new Map()
  if (!isCommitLedgerReady()) return 0
  const db = commitLedgerDb()
  const dayStart = startOfDay(now)
  const byRepo = db
    .prepare(`SELECT repo_uri AS uri, ${AGGREGATES} FROM commits WHERE superseded_by IS NULL GROUP BY repo_uri`)
    .all({ dayStart }) as Row[]
  for (const row of byRepo) fold(row, now)
  // The worktree key, only where it is genuinely a different project URI.
  const byCwd = db
    .prepare(
      `SELECT cwd_uri AS uri, repo_uri AS repo, ${AGGREGATES}
       FROM commits WHERE superseded_by IS NULL AND cwd_uri <> repo_uri GROUP BY cwd_uri, repo_uri`,
    )
    .all({ dayStart }) as Array<Row & { repo: string }>
  for (const row of byCwd) {
    if (projectIdentityKey(row.uri) === projectIdentityKey(row.repo)) continue
    fold(row, now)
  }
  return buckets.size
}

/** Fold one freshly-ingested commit into the map. Returns the project keys it
 *  touched, so the caller can broadcast exactly what changed. */
export function bumpProjectCommitStats(
  commit: { repoUri: string; cwdUri: string; origin: string; committedAt: number },
  now = Date.now(),
): string[] {
  const uris = [commit.repoUri]
  if (projectIdentityKey(commit.cwdUri) !== projectIdentityKey(commit.repoUri)) uris.push(commit.cwdUri)
  for (const uri of uris) {
    const bucket = dayRoll(ensure(projectIdentityKey(uri), now), now)
    bucket.total++
    if (commit.origin === 'agent') bucket.agent++
    else bucket.human++
    if (commit.committedAt >= bucket.todayStart) bucket.today++
    if (bucket.lastCommittedAt == null || commit.committedAt > bucket.lastCommittedAt) {
      bucket.lastCommittedAt = commit.committedAt
    }
  }
  return uris
}

export function getProjectCommitStats(projectUri: string, now = Date.now()): ProjectCommitStats {
  const bucket = buckets.get(projectIdentityKey(projectUri))
  if (!bucket) return { ...EMPTY }
  const { todayStart: _todayStart, ...stats } = dayRoll(bucket, now)
  return stats
}

/** Test seam: drop the cache so a suite starts from a known state. */
export function resetProjectCommitStats(): void {
  buckets = new Map()
}
