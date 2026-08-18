/**
 * Which directory a fork READS from, and which one it WRITES to.
 *
 * CC derives its transcript directory from the cwd it was LAUNCHED in, so these
 * two are independent facts and conflating them loses forks in both directions:
 *
 *  - READ  is history. A conversation born in `.claude/worktrees/<name>` wrote
 *    its transcript under that worktree's slug, and it is still there long
 *    after worktree-remove.sh deleted the directory itself.
 *  - WRITE is the future. A spawn with no target launches in the PROJECT ROOT,
 *    so a fork parked under the source worktree's slug is invisible to the
 *    `--resume` that follows -- CC finds nothing and starts fresh, which reads
 *    as "the fork lost all context" rather than as an error.
 *
 * Pure string composition on purpose: neither directory needs to exist. The
 * source worktree is usually already gone, and the target one is created at
 * spawn time, after the fork is written.
 */

import { worktreePath } from '../shared/worktree-path'

export interface ForkCwdRequest {
  /** Project root, already expanded from the URI by the sentinel. */
  projectCwd: string
  /** Worktree the SOURCE session ran in, if any. History -- may be deleted. */
  sourceWorktree?: string
  /** Worktree the fork will be launched in. Wins over `targetCwd`. */
  targetWorktree?: string
  /** Explicit launch directory for the fork, already expanded. */
  targetCwd?: string
}

export interface ForkCwds {
  /** Where the source transcript is read from. */
  cwd: string
  /** Where the fork is written. `undefined` means "beside the source". */
  targetCwd?: string
}

/**
 * `resolve` is the caller's realpath hook -- injected rather than imported so
 * this stays pure and testable, and so a path that no longer exists on disk
 * still resolves.
 */
export function resolveForkCwds(req: ForkCwdRequest, resolve: (p: string) => string = p => p): ForkCwds {
  const { projectCwd, sourceWorktree, targetWorktree, targetCwd } = req

  const cwd = resolve(sourceWorktree ? worktreePath(projectCwd, sourceWorktree) : projectCwd)

  // The launch default is the project root, NOT the source: that is where a
  // spawn without a target lands.
  let launchCwd = projectCwd
  if (targetWorktree) launchCwd = worktreePath(projectCwd, targetWorktree)
  else if (targetCwd) launchCwd = targetCwd
  const target = resolve(launchCwd)

  // Same directory either way means fork in place -- pass nothing rather than a
  // redundant path the writer would mkdir on top of what it just read.
  return { cwd, targetCwd: target === cwd ? undefined : target }
}
