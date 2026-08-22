/**
 * ONE FLAG: does this seat integrate itself, or does somebody else merge it?
 *
 * The anti-stranding machinery predates epic mode and fires unconditionally: an
 * ad-hoc worktree session that exits ahead of `main` fast-forwards `main` to its
 * own HEAD on the way out (`headless-lifecycle.ts` -> `fastForwardMain`), and a
 * dashboard-launched task is told in its prompt to run `worktree-finish.sh`.
 * For a throwaway branch nobody else will ever look at, that is correct -- the
 * alternative is work stranded on a dead branch.
 *
 * For an EPIC-DISPATCHED seat it is wrong, and it cost real money: four cards in
 * one run reached `main` as bare fast-forwards with no werk-master in the path,
 * one of them EIGHT SECONDS after its werk-verifier was dispatched. The guard
 * read the diff of code that was already merged. A rejected card would have to be
 * reverted rather than simply left alone, and one of those fast-forwards put a
 * RED `main` in front of a whole generation.
 *
 * So the seat DECLARES it. `worktreeMergeBack` rides the spawn plan next to
 * `model` and `effort`, crosses the wire as a `SpawnRequest` field, and reaches
 * the agent host as `RCLAUDE_WORKTREE_MERGEBACK`.
 *
 * WHY BOTH READERS LIVE IN THIS FILE. The two seams have always had OPPOSITE
 * defaults -- the prompt fragment is opt-IN (only the dashboard's worktree
 * checkbox ever asked for it) and the exit-time fast-forward is opt-OUT (it
 * fires unless something stops it). Folding them into one predicate would
 * silently flip one of them. Keeping them as two three-line functions in one
 * file, fed by ONE field, is what stops them disagreeing: they can only be read
 * together, and `worktree-mergeback.test.ts` pins that they agree on the value
 * that matters (`false` => neither seam acts).
 */

/** Env key the sentinel sets on the agent host process. `'0'` = HELD. */
export const WORKTREE_MERGEBACK_ENV = 'RCLAUDE_WORKTREE_MERGEBACK'

/**
 * SEAM 1 -- the prompt fragment (`spawn-prompt.ts`).
 *
 * OPT-IN: only a caller that explicitly asked for merge-back instructions gets
 * them. An epic seat never asks, and now says so out loud rather than by
 * omission.
 */
export function mergeBackInstructionsWanted(flag: boolean | undefined): boolean {
  return flag === true
}

/**
 * SEAM 2 -- the exit-time `fastForwardMain()` (`headless-lifecycle.ts`).
 *
 * OPT-OUT: absent means "fast-forward", because that is what every ad-hoc
 * session on a throwaway branch has always done and deleting that defence would
 * strand real work. Only an explicit `false` holds the branch.
 */
export function exitFastForwardAllowed(flag: boolean | undefined): boolean {
  return flag !== false
}

/** Sentinel side: the env entries for a seat's declared flag. Absent/true emits
 *  nothing, so an unmodified spawn is byte-identical to what it was before. */
export function worktreeMergeBackEnv(flag: boolean | undefined): Record<string, string> {
  return flag === false ? { [WORKTREE_MERGEBACK_ENV]: '0' } : {}
}

/** Agent-host side: read the declaration back off the process env. */
export function exitFastForwardAllowedFromEnv(env: Record<string, string | undefined>): boolean {
  return exitFastForwardAllowed(env[WORKTREE_MERGEBACK_ENV] === '0' ? false : undefined)
}

/**
 * THE LOUD LINE. A stranded branch and a deliberately-held one must never look
 * the same from outside -- the fourth occurrence was invisible precisely because
 * nothing said which of the two had happened.
 */
export function heldBranchDiag(branch: string, ahead: number, mainBranch: string): string {
  return `branch ${branch} left unmerged (${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${mainBranch}): the werk-master integrates it. Worktree and branch preserved on purpose.`
}
