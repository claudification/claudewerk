/**
 * Ingest normalization -- validate + clamp an untrusted hook payload into the
 * exact shape the insert statement wants. Pure; no DB, no network.
 *
 * NO SILENT TRUNCATION: when the file list is clamped the row records
 * `filesTruncated` and keeps the hook's ORIGINAL `fileCount`, so a 900-file
 * commit still reports 900 even though only the first 500 paths are stored.
 */

import type { CommitFile, CommitIngestPayload, CommitRow } from '../../shared/commit-ledger'
import { projectIdentityKey } from '../../shared/project-uri'
import { classifyKind, classifyOrigin, parseConventional, splitMessage } from './categorize'

const MAX_SUBJECT = 512
const MAX_BODY = 8_192
const MAX_FILES = 500
const MAX_PATH = 1_024
const HASH_RE = /^[0-9a-f]{7,64}$/i

export type NormalizedCommit = Omit<CommitRow, 'id' | 'supersededBy' | 'profile'>

function clamp(value: string | undefined, max: number): string {
  const text = (value ?? '').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function normalizeFiles(raw: CommitFile[] | undefined): CommitFile[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, MAX_FILES).map(f => ({
    status: clamp(String(f?.status ?? '?'), 8),
    path: clamp(String(f?.path ?? ''), MAX_PATH),
    ...(f?.from ? { from: clamp(String(f.from), MAX_PATH) } : {}),
  }))
}

function positiveInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export class CommitPayloadError extends Error {}

/** Throws `CommitPayloadError` on anything that would make the row meaningless
 *  (no hash, no repo identity). Everything else degrades to a default. */
export function normalizeCommit(payload: CommitIngestPayload, now: number): NormalizedCommit {
  const hash = String(payload.hash ?? '').trim()
  if (!HASH_RE.test(hash)) throw new CommitPayloadError('invalid or missing commit hash')
  // URIs are canonicalized ON THE WAY IN so every stored row is directly
  // index-matchable against a normalized query key. This is URI logic, not path
  // logic -- the broker never extracts a path back out (CWD IS INFORMATIONAL).
  const repoUri = projectIdentityKey(clamp(payload.repoUri, MAX_PATH))
  if (!repoUri) throw new CommitPayloadError('missing repoUri')

  const [subject, body] = splitMessage(payload.subject, payload.body)
  const files = normalizeFiles(payload.files)
  const conversationId = clamp(payload.conversationId, 128) || null
  const committedAt = positiveInt(payload.committedAt) || now

  return {
    hash: hash.toLowerCase(),
    shortHash: hash.toLowerCase().slice(0, 8),
    parentHashes: clamp(payload.parents, 1_024),
    repoUri,
    cwdUri: payload.cwdUri ? projectIdentityKey(clamp(payload.cwdUri, MAX_PATH)) : repoUri,
    repoName: clamp(payload.repoName, 128),
    branch: clamp(payload.branch, 256),
    isWorktree: Boolean(payload.isWorktree),
    conversationId,
    conversationName: clamp(payload.conversationName, 128) || null,
    sentinel: clamp(payload.sentinel, 64) || 'default',
    host: clamp(payload.host, 128) || 'unknown',
    container: clamp(payload.container, 128),
    osUser: clamp(payload.osUser, 64),
    authorName: clamp(payload.authorName, 128),
    authorEmail: clamp(payload.authorEmail, 256),
    subject: clamp(subject, MAX_SUBJECT) || '(no subject)',
    body: clamp(body, MAX_BODY),
    files,
    fileCount: positiveInt(payload.fileCount) || files.length,
    filesTruncated: Array.isArray(payload.files) && payload.files.length > MAX_FILES,
    insertions: positiveInt(payload.insertions),
    deletions: positiveInt(payload.deletions),
    kind: classifyKind(payload, subject),
    origin: classifyOrigin(conversationId, Boolean(payload.backfill)),
    committedAt,
    ingestedAt: now,
    ...parseConventional(subject),
  }
}

/** The FTS document for a commit: message plus every touched path, so
 *  `?q=auth.ts` and `?q="fix the race"` both hit. */
export function ftsDocument(row: Pick<NormalizedCommit, 'subject' | 'body' | 'files'>): string {
  return [row.subject, row.body, ...row.files.map(f => f.path)].filter(Boolean).join('\n')
}
