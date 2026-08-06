/** Row <-> object mapping for the commit ledger. Kept apart from the store so
 *  both the insert path and every query path share ONE definition of a row. */

import type { CommitFile, CommitKind, CommitOrigin, CommitRow } from '../../shared/commit-ledger'

export type RawCommitRow = Record<string, string | number | null>

function parseFiles(raw: unknown): CommitFile[] {
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as CommitFile[]) : []
  } catch {
    // A malformed blob must never poison a whole result page.
    return []
  }
}

export function toCommitRow(row: RawCommitRow): CommitRow {
  return {
    id: row.id as number,
    hash: row.hash as string,
    shortHash: row.short_hash as string,
    parentHashes: row.parent_hashes as string,
    repoUri: row.repo_uri as string,
    cwdUri: row.cwd_uri as string,
    repoName: row.repo_name as string,
    branch: row.branch as string,
    isWorktree: Boolean(row.is_worktree),
    conversationId: (row.conversation_id as string) ?? null,
    conversationName: (row.conversation_name as string) ?? null,
    sentinel: row.sentinel as string,
    profile: (row.profile as string) ?? null,
    host: row.host as string,
    container: row.container as string,
    osUser: row.os_user as string,
    authorName: row.author_name as string,
    authorEmail: row.author_email as string,
    subject: row.subject as string,
    body: row.body as string,
    files: parseFiles(row.files),
    fileCount: row.file_count as number,
    filesTruncated: Boolean(row.files_truncated),
    insertions: row.insertions as number,
    deletions: row.deletions as number,
    kind: row.kind as CommitKind,
    ccType: (row.cc_type as string) ?? null,
    ccScope: (row.cc_scope as string) ?? null,
    ccBreaking: Boolean(row.cc_breaking),
    origin: row.origin as CommitOrigin,
    supersededBy: (row.superseded_by as string) ?? null,
    committedAt: row.committed_at as number,
    ingestedAt: row.ingested_at as number,
  }
}

/** Every column the SELECTs need, minus the FTS document (large, never rendered). */
const COLUMN_NAMES = [
  'id',
  'hash',
  'short_hash',
  'parent_hashes',
  'repo_uri',
  'cwd_uri',
  'repo_name',
  'branch',
  'is_worktree',
  'conversation_id',
  'conversation_name',
  'sentinel',
  'profile',
  'host',
  'container',
  'os_user',
  'author_name',
  'author_email',
  'subject',
  'body',
  'files',
  'file_count',
  'files_truncated',
  'insertions',
  'deletions',
  'kind',
  'cc_type',
  'cc_scope',
  'cc_breaking',
  'origin',
  'superseded_by',
  'committed_at',
  'ingested_at',
] as const

export const COMMIT_COLUMNS = COLUMN_NAMES.join(', ')

/** The same column list qualified with a table alias, for the FTS join. */
export function commitColumns(alias: string): string {
  return COLUMN_NAMES.map(name => `${alias}.${name}`).join(', ')
}
