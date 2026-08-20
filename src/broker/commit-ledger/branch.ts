/**
 * WHICH COMMITS DELIVERED A BRANCH -- answered from `commits.db`, never from git.
 *
 * The promise ledger needs a sha to put in a card's `closes:`, and the one thing
 * it may not do is guess one. The broker cannot shell out (`bun run
 * lint:boundary`, CWD IS INFORMATIONAL) and `src/shared/` cannot either, so the
 * commit ledger is the resolver: a post-commit hook installed into the git
 * COMMON dir, which means one install covers main plus every worktree, so a
 * seat's commits are already here, attributed, by the time its card settles.
 *
 * TWO ANSWERS, RANKED, and the ranking is the honesty:
 *
 *   `merge`  -- a commit on the repo's own trunk whose subject names this
 *               branch. It IS on main by construction, so the promise reads
 *               `delivered` the moment it is written.
 *   `branch` -- the commits recorded ON the branch itself. Also facts, also
 *               attributed, but nothing here claims they reached main. The
 *               ledger's ancestry resolver answers that at READ time, which is
 *               why a branch that never merges renders `commit is NOT on main`
 *               without anyone having to come back and rewrite the card.
 *
 * That second answer is what makes the feature reachable at all: the WERK engine
 * never merges (the IMPLEMENTER seat merges its dependencies into its own
 * worktree; the verifier integrates nothing), so a merge commit usually does not
 * exist yet at the moment a card settles. Recording the branch's own commits is
 * not a weaker guess -- it is the same fact with a smaller claim attached.
 */

import type { CommitRow } from '../../shared/commit-ledger'
import { projectIdentityKey } from '../../shared/project-uri'
import { commitColumns, type RawCommitRow, toCommitRow } from './row'
import { commitLedgerDb, isCommitLedgerReady } from './store'

/** How a branch's commits were found. Carried through to the baton so a reader
 *  can tell "merged" from "committed but unmerged" without re-deriving it. */
export type BranchResolution = 'merge' | 'branch'

export interface BranchCommits {
  via: BranchResolution
  commits: CommitRow[]
}

/** Most shas we will ever write into one `closes:`. A branch with more commits
 *  than this had its history rewritten or is not what we think it is; a card
 *  carrying forty hashes is unreadable and stops being a receipt. */
const MAX_CLOSING_COMMITS = 12

/** Everything a project's commits could be filed under. A worktree commit
 *  carries the WORKTREE uri in `cwd_uri` while `repo_uri` is the main repo root,
 *  and a card's branch lives in a worktree by construction -- so matching only
 *  one of the two columns finds exactly the wrong half. */
function projectClause(projectUri: string, params: Record<string, string>): string {
  params.projectKey = projectIdentityKey(projectUri)
  return '(c.repo_uri = $projectKey OR c.cwd_uri = $projectKey)'
}

/**
 * A branch name, escaped for a LIKE pattern.
 *
 * Card ids routinely contain `_` and `-`, and `_` is LIKE's single-character
 * wildcard: unescaped, `werk_run` would also match `werk-run`, and the ledger
 * would file one card's merge commit against another card's promise. A false
 * sha is the one failure this whole module exists to avoid.
 */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, m => `\\${m}`)
}

function rows(sql: string, params: Record<string, string>): CommitRow[] {
  return (commitLedgerDb().prepare(sql).all(params) as RawCommitRow[]).map(toCommitRow)
}

/**
 * The merge commit that brought `branch` onto the trunk, newest first.
 *
 * Matched on the subject git writes itself (`Merge branch 'x'`, optionally
 * `... into y`) rather than on the parent graph, because the ledger stores
 * parents as an opaque string and walking it would be a second, slower way to
 * learn the same thing. `is_worktree = 0` is what keeps this to the trunk: a
 * merge performed inside a worktree is a seat integrating its dependencies, and
 * that is emphatically not delivery.
 */
function mergeCommit(projectUri: string, branch: string): CommitRow | null {
  const params: Record<string, string> = { pattern: `Merge branch '${likeLiteral(branch)}'%` }
  const found = rows(
    `SELECT ${commitColumns('c')} FROM commits c
     WHERE ${projectClause(projectUri, params)}
       AND c.is_worktree = 0
       AND c.superseded_by IS NULL
       AND c.subject LIKE $pattern ESCAPE '\\'
     ORDER BY c.committed_at DESC LIMIT 1`,
    params,
  )
  return found[0] ?? null
}

/** Every commit the ledger recorded ON this branch, oldest first -- the order
 *  they were written, which is the order they read best in. */
function branchCommits(projectUri: string, branch: string): CommitRow[] {
  const params: Record<string, string> = { branch }
  return rows(
    `SELECT ${commitColumns('c')} FROM commits c
     WHERE ${projectClause(projectUri, params)}
       AND c.branch = $branch
       AND c.superseded_by IS NULL
     ORDER BY c.committed_at ASC LIMIT ${MAX_CLOSING_COMMITS}`,
    params,
  )
}

/**
 * What delivered `branch`, or null when the ledger has never heard of it.
 *
 * NULL IS A RESULT, not an error. "I could not resolve a sha" is a real verdict
 * in this design and the caller writes nothing at all when it comes back --
 * `could not verify` is never folded into `delivered`.
 */
export function commitsForBranch(projectUri: string, branch: string): BranchCommits | null {
  if (!isCommitLedgerReady() || branch === '') return null

  const merge = mergeCommit(projectUri, branch)
  if (merge) return { via: 'merge', commits: [merge] }

  const own = branchCommits(projectUri, branch)
  return own.length > 0 ? { via: 'branch', commits: own } : null
}
