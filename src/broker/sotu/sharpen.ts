/**
 * Liveness-sharpened git alerts -- the broker-side pass the sentinel cannot do.
 *
 * The sentinel emits the git-observable floor (dirty => at-risk, main ahead =>
 * unpushed, far-behind => stalled) but never sees conversation liveness, so the
 * raw floor screams AT-RISK for every worktree an agent is actively working in
 * -- which is the NORMAL state of a busy fleet, i.e. zero signal. This pass
 * joins the fabric against "which worktrees have a live conversation right now"
 * and keeps only what is actually actionable:
 *
 *   - at-risk   : dirty worktree with NO live conversation -- genuinely
 *                 abandoned dirt, loss risk. (Dirty + live conv = suppressed:
 *                 that is just work happening.)
 *   - unmerged  : NEW. A worktree branch carrying unintegrated commits with no
 *                 live conversation -- a worker finished/died without merging
 *                 (the WORK MODE Law-3 failure mode). Rots silently otherwise.
 *   - unpushed / stalled : passed through from the sentinel floor unchanged
 *                 (liveness does not change their meaning).
 *
 * "Live" = a conversation whose sheaf status is running or idle -- still
 * attached, still able to act. Ended/killed/crashed convs do not hold a
 * worktree. Pure function; the caller supplies the live-worktree set.
 */

import type { GitAlert, GitFabric } from '../../shared/protocol'
import { detectWorktreeName } from '../../shared/worktree-detect'

/** Branch names that ARE the integration target -- never "unmerged". */
const MAIN_BRANCHES = new Set(['main', 'master'])

/**
 * Sharpen one fabric's alert union against conversation liveness.
 * `liveWorktrees` holds worktree NAMES (detectWorktreeName output); `null` in
 * the set means a live conversation sits in the main checkout.
 */
export function sharpenAlerts(fabric: GitFabric | undefined, liveWorktrees: ReadonlySet<string | null>): GitAlert[] {
  if (!fabric) return []
  const out = new Set<GitAlert>()
  for (const b of fabric.branches) {
    const live = b.worktree !== undefined && liveWorktrees.has(detectWorktreeName(b.worktree))
    for (const a of b.alerts) {
      if (a === 'at-risk' && live) continue // dirty + live conv = work happening
      out.add(a)
    }
    const unmergedWork = b.worktree !== undefined && !MAIN_BRANCHES.has(b.branch) && b.integration !== 'integrated'
    if (unmergedWork && !live) out.add('unmerged')
  }
  return [...out]
}
