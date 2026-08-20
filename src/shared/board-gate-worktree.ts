/**
 * WHICH CHECKOUT THE DONE-GATE MEASURES.
 *
 * The gate's git + test runners used to point at `ctx.getDialogCwd()`, and that
 * is the PROJECT ROOT for every conversation on this board -- an epic implementer
 * is spawned with cwd = the main checkout and only `cd`s into its worktree in the
 * shell (verified live: `whoami` reports cwd = the project root from inside a
 * worktree session). So the gate measured `main` while the work sat in
 * `.claude/worktrees/<...>/<card-id>`, and would have written
 * `evidence_branch: main`, `evidence_commits: 0`, an empty diffstat, and run the
 * card's `test_cmd` against code the worker never wrote. Under any mode but
 * `off` that refuses every honest worktree implementer with "no commits since
 * main" -- which is why turning the gate on before fixing this would have been
 * worse than leaving it off.
 *
 * The fix keeps evidence MACHINE-derived, adding no card field an agent could lie
 * in: the worktree is found by asking git, and matched on the CARD ID, which is
 * the board's primary key and also the directory name
 * `scripts/worktree-create.sh` gives it (`.claude/worktrees/<name>`, and for an
 * epic leg `.claude/worktrees/epic/<epic-id>/<card-id>`) -- both end in the card
 * id. Matching by card rather than by acting conversation is deliberate: the
 * verifier's `in-review -> done` move must re-measure the WORKER's tree, not its
 * own scratch checkout.
 *
 * Fails safe in both directions. No match -> the project root, i.e. exactly the
 * old behaviour, which is correct for a board whose work happens in the main
 * checkout. Two matches -> the project root as well, because a gate that guesses
 * which of two trees it measured is evidence nobody can trust; Tier-2 then
 * refuses loudly on the root's zero diff instead of stamping a plausible lie.
 */

import { join } from 'node:path'

export interface WorktreeEntry {
  path: string
  /** Short branch name, or absent for a detached worktree. */
  branch?: string
}

/** Parse `git worktree list --porcelain` into path/branch records. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      out.push({ path: line.slice('worktree '.length).trim() })
      continue
    }
    const last = out[out.length - 1]
    if (last && line.startsWith('branch ')) {
      last.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    }
  }
  return out
}

export interface GateCwd {
  /** Absolute checkout the gate's git + test runners should use. */
  cwd: string
  /** Why it landed there -- goes into the `[board-gate]` log line. */
  note: 'worktree' | 'no-worktree' | 'ambiguous'
}

/** Resolve the checkout holding `cardId`'s work, or the project root. */
export function resolveGateCwd(root: string, cardId: string, worktrees: WorktreeEntry[]): GateCwd {
  if (!cardId) return { cwd: root, note: 'no-worktree' }
  const prefix = `${join(root, '.claude', 'worktrees')}/`
  const matches = worktrees.filter(w => w.path.startsWith(prefix) && w.path.endsWith(`/${cardId}`))
  if (matches.length === 1) return { cwd: matches[0].path, note: 'worktree' }
  return { cwd: root, note: matches.length > 1 ? 'ambiguous' : 'no-worktree' }
}
