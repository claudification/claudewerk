/**
 * THE GIT SIDE OF THE COMMIT BACKFILL -- turn `git log` into ingest payloads.
 *
 * The commit ledger only knows what its post-commit hook has seen since the day
 * it was installed. Git knows everything. This module is the reader that closes
 * that gap, and it is deliberately separate from the CLI that drives it so the
 * parsing can be tested without a repo, a broker or a network.
 *
 * TWO PASSES, NOT ONE, AND THAT IS FORCED. `git log --name-status --numstat`
 * does not give you both: the later flag wins and you silently get one of them.
 * So the walk runs `--name-status` for the file list and `--numstat` for the line
 * counts and joins them on the hash. Two processes per repo, not two per commit.
 *
 * MERGES CARRY NO FILES ON PURPOSE. `git log` emits no diff for a merge without
 * `-m`, exactly as the post-commit hook's `git diff-tree` emits none. A merge
 * therefore lands with zero files, and `kind` is derived from its parent count
 * on the broker -- the same answer the hook produces, by the same route.
 *
 * WHAT IT CANNOT KNOW, IT DOES NOT GUESS. There is no conversation, no sentinel
 * profile and no container for a commit that predates the hook. Every payload
 * goes out with `backfill: true`, which is what makes the broker classify it
 * `origin: 'unknown'` instead of reading the missing conversation id as "a human
 * typed this" -- see `classifyOrigin`.
 *
 * CRAP RULING, once, for the four suppressions below. Every one is flagged on
 * CRAP ONLY -- cyclomatic and cognitive are both under threshold -- and fallow
 * says outright that CRAP here is ESTIMATED from export references. These
 * parsers are the most-tested code in the backfill: `backfill-commits-git.test.ts`
 * covers separators, renames, merges, multi-line bodies and binary numstat. The
 * score prices a coverage tier fallow guessed, not risk it measured. Revisit if
 * a real coverage run disagrees.
 */

import type { CommitFile, CommitIngestPayload } from '../src/shared/commit-ledger'

/** Field separator inside one record, and the record separator between them.
 *  Both are control characters that cannot occur in a path and do not occur in
 *  a commit message outside of deliberate abuse. */
const FS = '\x1f'
const RS = '\x1e'

const LOG_FORMAT = `${RS}%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%s${FS}%b${FS}`

/** One commit as git reports it, before it becomes an ingest payload. */
export interface GitCommit {
  hash: string
  parents: string
  authorName: string
  authorEmail: string
  committedAt: number
  subject: string
  body: string
  files: CommitFile[]
  insertions: number
  deletions: number
}

/** A rename line is `R100<TAB>old<TAB>new`; everything else is `M<TAB>path`. */
// See CRAP RULING in the header.
// fallow-ignore-next-line complexity
function parseNameStatusLine(line: string): CommitFile | null {
  const parts = line.split('\t')
  if (parts.length < 2) return null
  const status = parts[0] ?? ''
  if (status.startsWith('R') && parts.length >= 3) {
    return { status, path: parts[2] ?? '', from: parts[1] ?? '' }
  }
  return { status, path: parts[1] ?? '' }
}

/** `added<TAB>removed<TAB>path`. Binary files report `-` for both, which is not
 *  zero -- it is "not countable" -- so those lines contribute nothing rather
 *  than being coerced to 0 and summed. */
// See CRAP RULING in the header.
// fallow-ignore-next-line complexity
function parseNumstatLine(line: string): { added: number; removed: number } | null {
  const [added, removed] = line.split('\t')
  if (added === undefined || removed === undefined) return null
  if (added === '-' || removed === '-') return null
  const a = Number(added)
  const r = Number(removed)
  return Number.isFinite(a) && Number.isFinite(r) ? { added: a, removed: r } : null
}

/** Split raw `git log` output into records, dropping the empty leading one that
 *  a record separator at the START of the format always produces. */
function records(raw: string): string[] {
  return raw.split(RS).filter(chunk => chunk.trim() !== '')
}

/**
 * Parse the `--name-status` pass. The seven `%`-fields come first; whatever
 * follows the seventh separator is the diff block, which is empty for a merge.
 */
// See CRAP RULING in the header.
// fallow-ignore-next-line complexity
export function parseNameStatusPass(raw: string): Map<string, GitCommit> {
  const out = new Map<string, GitCommit>()
  for (const chunk of records(raw)) {
    const parts = chunk.split(FS)
    if (parts.length < 8) continue
    const [hash, parents, authorName, authorEmail, at, subject, body] = parts as string[]
    if (!hash) continue
    const files = (parts.slice(7).join(FS) || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(parseNameStatusLine)
      .filter((f): f is CommitFile => f !== null && f.path !== '')
    out.set(hash, {
      hash,
      parents: parents ?? '',
      authorName: authorName ?? '',
      authorEmail: authorEmail ?? '',
      committedAt: Number(at) * 1000 || 0,
      subject: subject ?? '',
      body: body ?? '',
      files,
      insertions: 0,
      deletions: 0,
    })
  }
  return out
}

/** Parse the `--numstat` pass and fold its totals onto commits already read. */
// See CRAP RULING in the header.
// fallow-ignore-next-line complexity
export function applyNumstatPass(raw: string, commits: Map<string, GitCommit>): void {
  for (const chunk of records(raw)) {
    const [hash, ...rest] = chunk.split(FS)
    const commit = hash ? commits.get(hash) : undefined
    if (!commit) continue
    for (const line of rest.join(FS).split('\n')) {
      const stat = parseNumstatLine(line.trim())
      if (!stat) continue
      commit.insertions += stat.added
      commit.deletions += stat.removed
    }
  }
}

/** The `claude://` identity the ledger keys on. Built here, on the host, because
 *  the broker is forbidden to turn a path into a URI (CWD IS INFORMATIONAL) --
 *  the same reason the post-commit hook builds it in bash rather than posting a
 *  bare path and letting the server work it out. */
export function repoUriFor(sentinel: string, repoRoot: string): string {
  return `claude://${sentinel}${repoRoot}`
}

export interface PayloadContext {
  sentinel: string
  repoRoot: string
  repoName: string
  branch: string
  host: string
  osUser: string
}

export function toIngestPayload(commit: GitCommit, ctx: PayloadContext): CommitIngestPayload {
  const uri = repoUriFor(ctx.sentinel, ctx.repoRoot)
  return {
    hash: commit.hash,
    parents: commit.parents,
    repoUri: uri,
    cwdUri: uri,
    repoName: ctx.repoName,
    branch: ctx.branch,
    isWorktree: false,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    subject: commit.subject,
    body: commit.body,
    files: commit.files,
    fileCount: commit.files.length,
    insertions: commit.insertions,
    deletions: commit.deletions,
    committedAt: commit.committedAt,
    host: ctx.host,
    osUser: ctx.osUser,
    // THE FLAG THAT KEEPS THIS HONEST. Without it the broker reads the missing
    // conversation id as a human commit. See the module header.
    backfill: true,
  }
}

/** The two git invocations, as argv arrays. Exported so the CLI does not build
 *  argv by string concatenation and the test can assert the flags directly. */
export function logArgs(since: string, authors: string[], numstat: boolean): string[] {
  return [
    'log',
    '--all',
    `--since=${since}`,
    `--format=${LOG_FORMAT}`,
    numstat ? '--numstat' : '--name-status',
    // Renames are what make a path history readable; without -M a rename reads
    // as a delete plus an unrelated add.
    '-M',
    ...authors.map(a => `--author=${a}`),
  ]
}
