/**
 * Fast-forward a repo's main branch to a worktree's HEAD.
 *
 * The old trick -- `git fetch . HEAD:main` -- is DEAD as of git 2.54: git
 * refuses to move a ref that is checked out in ANY working tree
 *   fatal: refusing to fetch into branch 'refs/heads/main' checked out at '<root>'
 * and main is permanently checked out at the repo root. The guard is CORRECT:
 * moving the ref under a live checkout leaves that tree's index disagreeing
 * with HEAD, so the root would show the merged files as uncommitted REVERSALS.
 *
 * So merge INSIDE the working tree that owns the branch. `--ff-only` can only
 * advance the ref, never rewrite it, and it aborts without touching anything
 * when a locally-modified file would be overwritten -- so it cannot eat another
 * agent's uncommitted work. Dirt on files the merge does NOT touch is fine and
 * deliberately not treated as a blocker: in a repo with a dozen live agents,
 * main is almost always dirty on something, and refusing on any dirt would make
 * merge-back permanently unusable.
 *
 * When main is checked out NOWHERE (bare repo, CI) the old fetch is still
 * correct and still permitted, so it stays as the fallback.
 *
 * Mirrored in the `ff_main` bash function in scripts/worktree-finish.sh,
 * scripts/worktree-remove.sh and their embedded copies in resolve-script.ts.
 * The four shell copies cannot share a file (each extracts standalone to its
 * own temp path), so they are kept byte-identical instead.
 */

import { spawnSync } from 'node:child_process'

export type FfMainVia = 'merge' | 'fetch'

export interface FfMainResult {
  ok: boolean
  /** git's own output -- names the offending files when it refuses. */
  message: string
  /** Which strategy was used, so a diag line can say so. */
  via: FfMainVia
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * `node:child_process`, not `Bun.spawnSync`: `web/tsconfig.json` typechecks all
 * of `src/shared/**` without Bun's types, so a `Bun.` reference in a non-test
 * file here breaks `bun run typecheck` on the web half.
 */
function run(cmd: string[], cwd: string): RunResult {
  const [bin, ...args] = cmd
  const res = spawnSync(bin, args, { cwd, encoding: 'utf8' })
  return {
    code: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  }
}

function combined(r: RunResult): string {
  return [r.stdout, r.stderr].filter(Boolean).join('\n')
}

/**
 * Absolute path of the working tree that has `branch` checked out, or null when
 * no tree holds it (bare repo, or the branch simply is not checked out).
 *
 * A branch can be checked out in at most ONE working tree -- that is the very
 * invariant git enforces with the refusal above -- so the first hit is the hit.
 */
export function worktreeHoldingBranch(cwd: string, branch: string): string | null {
  const list = run(['git', 'worktree', 'list', '--porcelain'], cwd)
  if (list.code !== 0) return null

  let current: string | null = null
  for (const line of list.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length)
    } else if (line === `branch refs/heads/${branch}`) {
      return current
    }
  }
  return null
}

/**
 * Fast-forward `mainBranch` to the HEAD of the worktree at `worktreeCwd`.
 * Never rewrites history and never overwrites uncommitted work; on refusal the
 * returned `message` carries git's own explanation verbatim.
 */
export function fastForwardMain(worktreeCwd: string, mainBranch: string): FfMainResult {
  const head = run(['git', 'rev-parse', '--verify', 'HEAD'], worktreeCwd)
  if (head.code !== 0) {
    return { ok: false, message: combined(head) || 'could not resolve HEAD', via: 'merge' }
  }

  const mainWorktree = worktreeHoldingBranch(worktreeCwd, mainBranch)
  if (!mainWorktree) {
    const fetched = run(['git', 'fetch', '.', `HEAD:${mainBranch}`], worktreeCwd)
    return { ok: fetched.code === 0, message: combined(fetched), via: 'fetch' }
  }

  const merged = run(['git', 'merge', '--ff-only', head.stdout], mainWorktree)
  return { ok: merged.code === 0, message: combined(merged), via: 'merge' }
}
