/**
 * Commit ledger types -- the wire payload the git hook POSTs, and the stored row.
 *
 * See `.claude/docs/plan-commit-ledger.md`. The HOOK builds the project URIs
 * (host-side path->URI conversion is legal there); the broker treats them as
 * opaque identity strings and never does path logic on them (CWD IS
 * INFORMATIONAL, lint:boundary Rule 4).
 */

/** One file touched by a commit. `status` is git's name-status letter
 *  (A/M/D/R/C/T), possibly with a similarity score (`R100`). */
export interface CommitFile {
  status: string
  path: string
  /** Rename/copy source path, when git reported one. */
  from?: string
}

/** What the post-commit hook sends. Everything optional except the identity
 *  core -- a hook running on a machine with less context still produces a
 *  useful row rather than a rejected one. */
export interface CommitIngestPayload {
  hash: string
  parents?: string
  repoUri: string
  cwdUri: string
  repoName?: string
  branch?: string
  isWorktree?: boolean
  conversationId?: string
  conversationName?: string
  sentinel?: string
  host?: string
  container?: string
  osUser?: string
  authorName?: string
  authorEmail?: string
  subject?: string
  body?: string
  files?: CommitFile[]
  /** Hook-reported file count BEFORE clamping, so truncation is never silent. */
  fileCount?: number
  insertions?: number
  deletions?: number
  /** git reflog action for this commit (`commit`, `commit (amend)`,
   *  `commit (merge)`, `rebase (pick)`, ...). The only precise amend signal
   *  available to a post-commit hook. */
  reflogAction?: string
  committedAt?: number
  /**
   * This payload came from a `git log` WALK, not from a live post-commit hook.
   *
   * It states a FACT about where the payload came from, and the broker derives
   * the classification from it -- which is the rule `categorize.ts` already
   * runs on. Without it a backfilled commit has no `conversationId`, and
   * `classifyOrigin` would read that absence as "a human typed this", relabelling
   * every agent commit in the walk as Jonas's own work.
   *
   * It also suppresses the ingest broadcasts. A backfill is HISTORY, not news:
   * fourteen thousand `commit_recorded` frames would fill the COMMIT RIVER with
   * commits from last year as though they had just landed.
   */
  backfill?: boolean
}

export type CommitKind = 'normal' | 'merge' | 'revert' | 'initial' | 'amend' | 'rebase'
/**
 * Who made the commit -- and `unknown` is the one that matters.
 *
 * The ledger learns about a commit two ways. A live post-commit hook knows which
 * conversation it ran inside, so `agent` and `human` are both a MEASUREMENT. A
 * `git log` backfill knows neither: the commit predates the hook, and nothing on
 * disk records whether an agent or a person authored it.
 *
 * Folding that third case into `human` is the exact failure the activity grid's
 * three cell states exist to prevent, one layer down -- "we do not know" is not
 * "a person did it". So it gets its own value, and the filter can ask for it.
 */
export type CommitOrigin = 'agent' | 'human' | 'unknown'

export interface CommitRow {
  id: number
  hash: string
  shortHash: string
  parentHashes: string
  repoUri: string
  cwdUri: string
  repoName: string
  branch: string
  isWorktree: boolean
  conversationId: string | null
  conversationName: string | null
  sentinel: string
  profile: string | null
  host: string
  container: string
  osUser: string
  authorName: string
  authorEmail: string
  subject: string
  body: string
  files: CommitFile[]
  fileCount: number
  filesTruncated: boolean
  insertions: number
  deletions: number
  kind: CommitKind
  ccType: string | null
  ccScope: string | null
  ccBreaking: boolean
  origin: CommitOrigin
  supersededBy: string | null
  committedAt: number
  ingestedAt: number
}

export interface CommitQuery {
  conversationId?: string
  /** Matches EITHER repo_uri or cwd_uri, both normalized. A conversation
   *  launched inside a worktree carries the worktree URI, while the ledger's
   *  repo_uri is the main repo root -- matching both is what makes a project
   *  page show every worktree's commits. */
  projectUris?: string[]
  /** FTS query over subject + body + paths. */
  text?: string
  /** Substring match on a touched path. */
  path?: string
  origin?: CommitOrigin
  includeSuperseded?: boolean
  /** Keyset cursor: rows strictly older than (before, beforeId). Paired so a
   *  second holding several commits cannot drop rows across a page boundary. */
  before?: number
  beforeId?: number
  limit?: number
  offset?: number
}
