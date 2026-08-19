/**
 * P2's model layer: a ledger row -> a river row, and the hour band it sits in.
 *
 * Pure on purpose. The bucket boundaries and the delta-t column are the two
 * things this pane can get quietly wrong -- a commit filed under YESTERDAY that
 * landed twenty minutes ago is a lie you only catch by reading the clock -- so
 * they are functions with a `nowMs` argument rather than anything that reads
 * `Date.now()` behind the component.
 */

import type { CommitRow } from '@shared/commit-ledger'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/**
 * The hour bands the card names, plus OLDER.
 *
 * The card specifies three. The feed is cursor-paginated over the whole ledger
 * and `loadMore` walks back through weeks, so a fourth band exists or every
 * commit older than yesterday would be filed under YESTERDAY -- the one failure
 * a separator is supposed to prevent.
 */
export type RiverBucket = 'LAST HOUR' | 'EARLIER TODAY' | 'YESTERDAY' | 'OLDER'

/** Newest first, which is also the order the feed arrives in. */
const RIVER_BUCKETS: readonly RiverBucket[] = ['LAST HOUR', 'EARLIER TODAY', 'YESTERDAY', 'OLDER'] as const

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Which band a commit belongs to.
 *
 * LAST HOUR is measured on the CLOCK and wins outright; the other three are
 * CALENDAR days. At 00:20 a commit from 23:50 is forty minutes old and belongs
 * under LAST HOUR, not under YESTERDAY -- "an hour ago" is what a human means,
 * and midnight is not a fact about the work.
 *
 * Yesterday's start is derived by stepping back half a day and re-flooring
 * rather than subtracting 24h, so a DST shift does not move the boundary by an
 * hour and drop a commit into OLDER.
 */
export function riverBucket(committedAt: number, nowMs: number): RiverBucket {
  if (nowMs - committedAt < HOUR_MS) return 'LAST HOUR'
  const today = startOfDay(nowMs)
  if (committedAt >= today) return 'EARLIER TODAY'
  if (committedAt >= startOfDay(today - 12 * HOUR_MS)) return 'YESTERDAY'
  return 'OLDER'
}

/**
 * The delta-t column, in the width the mockup measured (32px).
 *
 * Deliberately not `commitAge()` from `lib/commits`: that one says "3m ago",
 * which is the right sentence for a detail surface and two characters too wide
 * for a column that has to leave room for the project name.
 */
export function riverAge(ageMs: number): string {
  const mins = Math.floor(ageMs / MINUTE_MS)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** How a project is meant to look, resolved by the caller from project settings. */
export interface RiverProjectLook {
  projectName: string
  projectIcon?: string
  projectColor?: string
}

export interface RiverRow {
  /** React key + row identity. The hash is unique in the ledger. */
  key: string
  hash: string
  shortHash: string
  subject: string
  branch: string
  host: string
  insertions: number
  deletions: number
  ageMs: number
  /** `ageMs`, in the delta-t column's format. */
  age: string
  bucket: RiverBucket
  projectName: string
  projectIcon?: string
  projectColor?: string
  /** What the row's tooltip promises the click will reach, when there is one. */
  conversationName: string | null
  hasConversation: boolean
}

/**
 * Attribution is read off `repoUri`, never `cwdUri`.
 *
 * A conversation running in `.claude/worktrees/<branch>` commits with a cwd
 * inside the worktree, and the hook records the main repo root as `repoUri`.
 * This pane answers "whose work landed", so it names the repo -- otherwise every
 * worktree would read as its own project and the one number this pane exists to
 * give you would be split across twelve rows.
 */
export function commitRiverRows(
  commits: readonly CommitRow[],
  look: (uri: string) => RiverProjectLook,
  nowMs: number,
): RiverRow[] {
  return commits.map(commit => {
    const ageMs = Math.max(0, nowMs - commit.committedAt)
    return {
      key: commit.hash,
      hash: commit.hash,
      shortHash: commit.shortHash,
      subject: commit.subject,
      branch: commit.branch,
      host: commit.host,
      insertions: commit.insertions,
      deletions: commit.deletions,
      ageMs,
      age: riverAge(ageMs),
      bucket: riverBucket(commit.committedAt, nowMs),
      conversationName: commit.conversationName,
      hasConversation: commit.conversationId !== null,
      ...look(commit.repoUri),
    }
  })
}

export interface RiverBand {
  bucket: RiverBucket
  rows: RiverRow[]
}

/**
 * Rows grouped under their separators, empty bands dropped.
 *
 * Grouped by BAND ORDER rather than by walking consecutive rows: the feed is
 * newest-first today, but a live commit prepends and a clock that jumped
 * backwards would put one row out of order, and consecutive grouping would
 * answer that by printing the same separator twice.
 */
export function riverBands(rows: readonly RiverRow[]): RiverBand[] {
  const bands: RiverBand[] = []
  for (const bucket of RIVER_BUCKETS) {
    const inBand = rows.filter(row => row.bucket === bucket)
    if (inBand.length) bands.push({ bucket, rows: inBand })
  }
  return bands
}
