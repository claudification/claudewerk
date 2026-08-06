/**
 * Commit ledger store -- init / insert / point lookups.
 *
 * The insert path is deliberately synchronous: one prepared statement against a
 * WAL database is sub-millisecond, and a queue would buy microseconds at the
 * price of a whole new failure mode (dropped-on-restart). The HOOK is what must
 * never block, and it doesn't -- it fires a backgrounded, time-capped curl.
 */

import type { Database, Statement } from 'bun:sqlite'
import { resolve } from 'node:path'
import type { CommitRow } from '../../shared/commit-ledger'
import { openWalDatabase } from '../sqlite-open'
import { ftsDocument, type NormalizedCommit } from './normalize'
import { COMMIT_COLUMNS, type RawCommitRow, toCommitRow } from './row'
import { createCommitSchema } from './schema'

/** How long after a commit an amend is still believed. Beyond this the reflog
 *  claim is stale enough that superseding an old row would be a guess. */
const AMEND_WINDOW_MS = 12 * 60 * 60 * 1_000

const INSERT_SQL = `INSERT INTO commits (
  hash, short_hash, parent_hashes, repo_uri, cwd_uri, repo_name, branch, is_worktree,
  conversation_id, conversation_name, sentinel, profile, host, container, os_user,
  author_name, author_email, subject, body, files, file_count, files_truncated,
  insertions, deletions, kind, cc_type, cc_scope, cc_breaking, origin, fts_doc,
  committed_at, ingested_at
) VALUES (
  $hash, $shortHash, $parentHashes, $repoUri, $cwdUri, $repoName, $branch, $isWorktree,
  $conversationId, $conversationName, $sentinel, $profile, $host, $container, $osUser,
  $authorName, $authorEmail, $subject, $body, $files, $fileCount, $filesTruncated,
  $insertions, $deletions, $kind, $ccType, $ccScope, $ccBreaking, $origin, $ftsDoc,
  $committedAt, $ingestedAt
) ON CONFLICT(hash, repo_uri) DO NOTHING`

interface Prepared {
  insert: Statement
  byHash: Statement
  amendCandidates: Statement
  supersede: Statement
  existingId: Statement
}

let db: Database | null = null
let stmts: Prepared | null = null

function prepare(database: Database): Prepared {
  return {
    insert: database.prepare(INSERT_SQL),
    byHash: database.prepare(
      `SELECT ${COMMIT_COLUMNS} FROM commits WHERE hash LIKE $prefix ORDER BY committed_at DESC LIMIT 50`,
    ),
    amendCandidates: database.prepare(
      `SELECT id FROM commits
       WHERE repo_uri = $repoUri AND parent_hashes = $parentHashes AND hash != $hash
         AND superseded_by IS NULL AND committed_at >= $since`,
    ),
    supersede: database.prepare('UPDATE commits SET superseded_by = $hash WHERE id = $id'),
    existingId: database.prepare('SELECT id FROM commits WHERE hash = $hash AND repo_uri = $repoUri'),
  }
}

function attach(database: Database): void {
  db = database
  createCommitSchema(database)
  stmts = prepare(database)
}

export function initCommitLedger(cacheDir: string): void {
  if (db) return
  attach(openWalDatabase(resolve(cacheDir, 'commits.db')))
}

export function closeCommitLedger(): void {
  db?.close()
  db = null
  stmts = null
}

export function commitLedgerDb(): Database {
  if (!db) throw new Error('commit ledger not initialized')
  return db
}

export function isCommitLedgerReady(): boolean {
  return db !== null
}

/** Mark the row an `--amend` replaced. Only ever called when the reflog said
 *  amend: two sibling commits off the same parent (routine under WORK MODE,
 *  where every worktree branches from main) must NEVER supersede each other. */
function applyAmendSupersession(commit: NormalizedCommit, prepared: Prepared): number {
  if (commit.kind !== 'amend') return 0
  const candidates = prepared.amendCandidates.all({
    repoUri: commit.repoUri,
    parentHashes: commit.parentHashes,
    hash: commit.hash,
    since: commit.committedAt - AMEND_WINDOW_MS,
  }) as Array<{ id: number }>
  for (const row of candidates) prepared.supersede.run({ hash: commit.hash, id: row.id })
  return candidates.length
}

export interface InsertResult {
  inserted: boolean
  id: number
  supersededCount: number
}

export function insertCommit(commit: NormalizedCommit, profile: string | null): InsertResult {
  if (!stmts) throw new Error('commit ledger not initialized')
  const { changes, lastInsertRowid } = stmts.insert.run({
    ...commit,
    isWorktree: commit.isWorktree ? 1 : 0,
    filesTruncated: commit.filesTruncated ? 1 : 0,
    ccBreaking: commit.ccBreaking ? 1 : 0,
    files: JSON.stringify(commit.files),
    ftsDoc: ftsDocument(commit),
    profile,
  })
  if (changes === 0) {
    const existing = stmts.existingId.get({ hash: commit.hash, repoUri: commit.repoUri }) as { id: number } | null
    return { inserted: false, id: existing?.id ?? 0, supersededCount: 0 }
  }
  return {
    inserted: true,
    id: Number(lastInsertRowid),
    supersededCount: applyAmendSupersession(commit, stmts),
  }
}

/** Lookup by full hash or unambiguous prefix (>= 4 chars). */
export function getCommitsByHash(prefix: string): CommitRow[] {
  if (!stmts || prefix.length < 4) return []
  return (stmts.byHash.all({ prefix: `${prefix.toLowerCase()}%` }) as RawCommitRow[]).map(toCommitRow)
}
