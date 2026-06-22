/**
 * Worktree-correct spawning -- the shared guard for ANY code that AUTOMATES a
 * spawn (the dispatcher, the nightshift ACT bar, future schedulers).
 *
 * `dispatchSpawn` takes `cwd` VERBATIM -- there is NO automatic rewrite to a
 * worktree. So worktree-correctness is the CALLER's responsibility.
 *
 * The lesson this encodes (learned the hard way 2026-06-22, and again the reason
 * the nightshift P0 worker wrote into main): a spawn that NAMES a worktree/branch
 * but carries `cwd = <project root>` (i.e. main) makes the spawned worker write
 * into MAIN, alongside the worktree, instead of into its own isolated worktree.
 * That is the bug. This module computes the correct cwd and REFUSES the broken
 * combination before the request leaves the caller.
 *
 * Convention: `<projectRoot>/.claude/worktrees/<name>` (see worktree-detect.ts).
 *
 * NOTE: the dispatcher slice (branch worktree-dispatcher) carries a broker-local
 * copy at src/broker/desk/worktree.ts with the same rule. When that lands, it
 * should re-export from here -- this shared module is the single source of truth.
 */

import { detectWorktreeName } from './worktree-detect'

/** Thrown when an automated spawn would NOT be worktree-correct. */
export class WorktreeCorrectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeCorrectError'
  }
}

const WORKTREE_SEGMENT = '/.claude/worktrees/'

/** Strip a trailing slash so path joins/compares are stable. */
function trimTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}

/** Fold `<root>/.claude/worktrees/<name>(/...)` back to `<root>`. */
export function stripWorktreeSegment(p: string): string {
  const idx = p.indexOf(WORKTREE_SEGMENT)
  return idx === -1 ? p : p.slice(0, idx)
}

/**
 * The worktree-correct cwd for a branch/worktree under a project root:
 *   computeWorktreeCwd('/repo', 'fix-mic') -> '/repo/.claude/worktrees/fix-mic'
 *
 * If `projectRoot` is ITSELF a worktree path, fold it back to the real root
 * first so we never nest `.claude/worktrees/.claude/worktrees/`.
 */
export function computeWorktreeCwd(projectRoot: string, worktreeName: string): string {
  const name = worktreeName.trim()
  if (!name || name.includes('/')) {
    throw new WorktreeCorrectError(`invalid worktree name: ${JSON.stringify(worktreeName)}`)
  }
  const root = trimTrailingSlash(stripWorktreeSegment(projectRoot))
  return `${root}${WORKTREE_SEGMENT}${name}`
}

/** True when `cwd` is inside a `.claude/worktrees/<name>` path. */
export function isWorktreeCwd(cwd: string | undefined | null): boolean {
  return detectWorktreeName(cwd ?? undefined) !== null
}

export interface WorktreeSpawnCheck {
  /** The cwd the spawn would use (verbatim, as passed to dispatchSpawn). */
  cwd: string
  /** The worktree/branch the caller intends to spawn into, if any. */
  worktreeName?: string | null
}

/**
 * THE GUARD. Validate that an automated spawn is worktree-correct.
 *
 * Refuses (throws WorktreeCorrectError) when a worktree is intended but the cwd
 * does not actually land inside THAT worktree:
 *   - cwd is the project root (main) -> the original bug.
 *   - cwd is a DIFFERENT worktree than intended -> a cross-wire bug.
 *
 * A no-worktree spawn (no `worktreeName`) is always allowed -- not every spawn
 * needs a worktree (e.g. an integrate-to-main act runs at the project root). Call
 * this immediately before handing `cwd` to the spawn request.
 */
export function assertWorktreeCorrectSpawn(check: WorktreeSpawnCheck): void {
  const intended = check.worktreeName?.trim()
  if (!intended) return // no worktree intended -> nothing to enforce

  const actual = detectWorktreeName(check.cwd)
  if (actual === null) {
    throw new WorktreeCorrectError(
      `refusing spawn: worktree '${intended}' intended but cwd is not a worktree path ` +
        `(cwd='${check.cwd}'). A worker spawned here would write into MAIN, not the worktree. ` +
        `Set cwd to ${computeWorktreeCwd(check.cwd, intended)}.`,
    )
  }
  if (actual !== intended) {
    throw new WorktreeCorrectError(
      `refusing spawn: cwd is in worktree '${actual}' but '${intended}' was intended (cwd='${check.cwd}').`,
    )
  }
}
