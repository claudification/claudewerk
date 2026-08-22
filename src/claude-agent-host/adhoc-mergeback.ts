/**
 * The exit-time worktree merge-back -- LAYER 3 of the anti-stranding defence,
 * lifted out of `headless-lifecycle.ts` so it can be run against a real git
 * fixture instead of only in production.
 *
 * CC will not get a chance to fire its own WorktreeRemove hook (the host kills it
 * on exit), so the host merges + cleans up directly. What is new is that it now
 * asks first: a seat that declared `worktreeMergeBack: false` -- every
 * epic-dispatched werk-worker and werk-verifier -- leaves `main` alone, leaves
 * its branch alone, leaves its worktree standing, and SAYS SO. See
 * `../shared/worktree-mergeback.ts` for why the flag exists and why both seams
 * read it from one file.
 *
 * The worktree has to survive too, not just the branch: the epic engine's only
 * structural check for "work landed with no werk-master" is
 * `rev-list --count main..<branch>`, and the fourth occurrence of this bug was
 * invisible because the seat removed its own worktree AND deleted its local
 * branch, leaving the scan nothing to count.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fastForwardMain } from '../shared/git-ff-main'
import { exitFastForwardAllowedFromEnv, heldBranchDiag } from '../shared/worktree-mergeback'

export interface MergeBackDeps {
  /** Structured line the dashboard shows. This is where a human reads it. */
  diag: (scope: string, message: string) => void
  /** Debug log line. */
  debug: (message: string) => void
  /** Process env, injected so a test never has to mutate the real one. */
  env: Record<string, string | undefined>
}

export interface MergeBackInput {
  /** Project ROOT (where `main` is checked out), not the worktree. */
  projectRoot: string
  /** Absolute worktree path. */
  worktreePath: string
  /** Worktree NAME, as `--worktree` was given it. Diag text only. */
  worktreeName: string
  /** The branch the worktree has checked out. */
  branch: string
}

export type MergeBackOutcome =
  /** The worktree was already gone (CC cleaned it up itself). */
  | { kind: 'absent' }
  /** The seat declared it does not integrate itself. Nothing was touched. */
  | { kind: 'held'; ahead: number }
  /** `main` did not move (nothing to merge) but cleanup ran, as it always has. */
  | { kind: 'nothing-to-merge'; removed: boolean }
  /** `main` was fast-forwarded; `removed` says whether cleanup then succeeded. */
  | { kind: 'merged'; ahead: number; removed: boolean }
  /** The fast-forward was attempted and refused. Worktree preserved. */
  | { kind: 'refused'; ahead: number; message: string }
  /** git itself blew up. Worktree preserved. */
  | { kind: 'error'; message: string }

function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: res.status ?? 1, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim() }
}

/**
 * Merge an ad-hoc worktree back to main and clean it up -- unless the seat said
 * not to.
 *
 * THE ORDER MATTERS. The ahead-count is taken BEFORE the flag is consulted, so
 * the held-branch diag can name a real number; a line that says "left unmerged"
 * without saying how much is left is the same silence this fix exists to break.
 */
export function adHocMergeBack(input: MergeBackInput, deps: MergeBackDeps): MergeBackOutcome {
  const { worktreePath, branch } = input

  try {
    deps.debug(`[ad-hoc] Worktree cleanup: path=${worktreePath} branch=${branch}`)

    if (!existsSync(worktreePath)) {
      deps.debug(`[ad-hoc] Worktree already gone: ${worktreePath}`)
      deps.diag('ad-hoc', 'Worktree already cleaned up by CC')
      return { kind: 'absent' }
    }

    const mainBranch = git(['rev-parse', '--verify', 'main'], worktreePath).code === 0 ? 'main' : 'master'
    const ahead = Number.parseInt(git(['rev-list', '--count', `${mainBranch}..HEAD`], worktreePath).stdout, 10) || 0

    // THE FORK. An epic seat stops here, ahead or not: it may not move `main`,
    // and it may not remove the worktree the engine's unmerged-branch scan reads.
    if (!exitFastForwardAllowedFromEnv(deps.env)) {
      const line =
        ahead > 0
          ? heldBranchDiag(branch, ahead, mainBranch)
          : `branch ${branch} carries nothing new; ${mainBranch} untouched (this seat does not integrate itself)`
      deps.debug(`[ad-hoc] ${line}`)
      deps.diag('ad-hoc', line)
      return { kind: 'held', ahead }
    }

    if (ahead === 0) {
      deps.debug(`[ad-hoc] Branch ${branch} already merged (0 commits ahead)`)
      return { kind: 'nothing-to-merge', removed: removeWorktree(input, deps) }
    }

    // Layer 3 of the merge-back defense. This used to call
    // `git fetch . HEAD:<main>` and report ANY failure as "unmerged commits",
    // which became a lie the day git started refusing to move a checked-out ref:
    // the commits merged fine, git just was not allowed to say so, and every
    // ad-hoc worktree silently "preserved" itself. fastForwardMain() merges
    // inside main's own worktree and hands back git's verbatim reason --
    // LOG EVERYTHING, never a bare failure.
    const ff = fastForwardMain(worktreePath, mainBranch)
    if (!ff.ok) {
      deps.debug(
        `[ad-hoc] Cannot fast-forward ${mainBranch} (${ahead} commits on ${branch}, via=${ff.via}): ${ff.message}`,
      )
      deps.diag(
        'ad-hoc',
        `WARNING: could not fast-forward ${mainBranch} (${ahead} commits on ${branch}) - worktree preserved: ${ff.message}`,
      )
      deps.diag('ad-hoc', `Worktree NOT removed (unmerged work on ${branch}). NO CODE LOST.`)
      return { kind: 'refused', ahead, message: ff.message }
    }

    deps.debug(`[ad-hoc] Merged ${ahead} commits from ${branch} to ${mainBranch} (via ${ff.via})`)
    deps.diag('ad-hoc', `Merged ${ahead} commits from ${branch} to ${mainBranch}`)
    return { kind: 'merged', ahead, removed: removeWorktree(input, deps) }
  } catch (e) {
    deps.debug(`[ad-hoc] Worktree cleanup failed: ${e}`)
    deps.diag('ad-hoc', `Worktree cleanup error: ${e} - worktree preserved`)
    return { kind: 'error', message: String(e) }
  }
}

/** Remove the merged worktree + its branch from the project root (must be run
 *  outside the worktree). Failure is logged and never fatal. */
function removeWorktree(input: MergeBackInput, deps: MergeBackDeps): boolean {
  const { projectRoot, worktreePath, worktreeName, branch } = input
  const removed = git(['worktree', 'remove', worktreePath], projectRoot)
  if (removed.code !== 0) {
    deps.debug(`[ad-hoc] Worktree remove failed: ${removed.stderr}`)
    deps.diag('ad-hoc', `Worktree remove failed: ${removed.stderr} - leaving in place`)
    return false
  }
  deps.debug(`[ad-hoc] Removed worktree: ${worktreePath}`)
  deps.diag('ad-hoc', `Worktree removed: ${worktreeName}`)
  const branchDel = git(['branch', '-d', branch], projectRoot)
  if (branchDel.code === 0) {
    deps.debug(`[ad-hoc] Deleted branch: ${branch}`)
    deps.diag('ad-hoc', `Branch deleted: ${branch}`)
  } else {
    deps.debug(`[ad-hoc] Branch delete failed: ${branchDel.stderr}`)
  }
  return true
}
