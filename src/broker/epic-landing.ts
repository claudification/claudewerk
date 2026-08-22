/**
 * THE ENGINE HALF of the landing gate: which card, which branch, and what the
 * git-fabric scan says about it.
 *
 * `src/shared/epic-landing.ts` is the RULE -- pure, targetted, and the only place
 * `pr` vs `merged` decides anything. This file turns one sentinel scan into one
 * verdict per `done` card.
 *
 * ONE SOURCE. `GitDirt` is the git-fabric snapshot the sentinel produces
 * (`git-fabric.ts`): every local branch, whether a worktree holds it, and how far
 * ahead of LOCAL main it is. Two facts come out of it and they are the two halves
 * of "delivered":
 *
 *   MERGED    `aheadLocal === 0` -- `rev-list --count main..<branch>`. True for a
 *             fast-forward, a no-ff merge and a rebase-then-ff alike.
 *   CLEANED   the branch is not in the scan at all, which is what
 *             `worktree-remove.sh` leaves behind and what it REFUSES to leave
 *             behind while anything is unmerged.
 *
 * WHY NOT THE COMMIT LEDGER, which is right next door and free. It recognises a
 * MERGE COMMIT by subject, and a fast-forward makes none -- so under the merge
 * policy this repo and this engine's own werk-master prompt both use, every
 * delivered card would read "not merged" forever and this gate would park healthy
 * runs. See `LandingEvidence`. The ledger stays exactly where it was, writing
 * `closes:` receipts (`epic-promise.ts`), where a missed fast-forward costs a
 * weaker claim rather than a stopped run.
 *
 * NOTHING HERE MERGES ANYTHING, and that is the boundary rather than an omission:
 * the broker is a broker, the sentinel owns the filesystem and git, and the
 * werk-master seat is the party whose job the merge is. The engine CHECKS. What
 * this file produces is a fact; what the beat does with it (hold, escalate, park)
 * lives in `epic-beat.ts`.
 */

import { type CardLanding, type LandingEvidence, landingVerdict } from '../shared/epic-landing'
import type { EpicRunTarget } from '../shared/epic-run-types'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import { cardBranch } from './epic-spawn-plan'
import type { GitDirt } from './epic-types'

/**
 * Lanes whose work is supposed to be delivered.
 *
 * `done` AND NOT `archived`, unlike the promise ledger's `TERMINAL_LANES`. The
 * two are asking different questions: a promise is a RECEIPT, and an abandoned
 * card that happened to produce commits still deserves one. This is a GATE, and
 * `archived` means "we decided not to do this" -- demanding a merge for work
 * somebody deliberately dropped would freeze a run over a decision it already
 * recorded. `epic-cards.ts` agrees: `archived` leaves the denominator entirely.
 */
const DELIVERING_LANES = new Set<ProjectTaskMeta['status']>(['done'])

/**
 * The epic's children, off the whole board.
 *
 * The FILTER LIVES HERE rather than at the call sites, because a caller that
 * forgot it would ask about `worktree-epic/<this epic>/<some other epic's card>`
 * -- a branch that has never existed, absent from the scan, read as delivered,
 * silently harmless and completely wasted work. Parenthood is the `epic:` key on
 * the CHILD (epic-cards.ts); there is no parent-side list.
 */
function childrenOf(cards: readonly ProjectTaskMeta[], epicId: string): ProjectTaskMeta[] {
  return cards.filter(c => c.epic === epicId)
}

/** One branch, in the rule's vocabulary. The whole mapping, in one place, so the
 *  scan's shape and the rule's words cannot drift apart. */
function evidenceOf(branch: string, fabric: GitDirt | null): LandingEvidence {
  if (!fabric?.ok) return 'unscanned'
  if (!fabric.known.has(branch)) return 'gone'
  return fabric.merged.has(branch) ? 'merged' : 'ahead'
}

export interface LandingScope {
  epicId: string
  /** The run's delivery rung. THE ENGINE READS IT HERE. */
  target: EpicRunTarget
  /**
   * The git-fabric snapshot, or `null` when this beat did not buy the round trip.
   *
   * `null` AND A FAILED SCAN ARE THE SAME ANSWER -- `unscanned`, which withholds
   * nothing and unblocks nothing. A beat that could not look must not certify a
   * repo it never read, and must not accuse one either.
   */
  fabric: GitDirt | null
}

/**
 * WHERE EVERY DELIVERING CARD'S WORK IS, this beat.
 *
 * Returns one entry per `done` card, INCLUDING the ones that landed cleanly: the
 * callers want to be able to say "12 of 12 delivered" as easily as they say which
 * three did not, and filtering here would leave `unresolvedLandings` looking like
 * the whole answer rather than a subset of it.
 */
export function resolveLandings(scope: LandingScope, cards: readonly ProjectTaskMeta[]): CardLanding[] {
  const out: CardLanding[] = []
  for (const card of childrenOf(cards, scope.epicId)) {
    if (!DELIVERING_LANES.has(card.status)) continue
    const branch = cardBranch(scope.epicId, card.slug)
    const evidence = evidenceOf(branch, scope.fabric)
    out.push({ cardId: card.slug, branch, evidence, verdict: landingVerdict({ evidence, target: scope.target }) })
  }
  return out
}

/**
 * IS THE GIT SCAN WORTH BUYING ON THIS BEAT?
 *
 * The scan is a sentinel round trip with a 15-second ceiling, so it is not free
 * and it is not taken on faith. The one thing that makes it unnecessary is having
 * nothing to ask about: an epic with no `done` child has no delivery claim to
 * check, which covers the whole early life of a run and every run of a board that
 * is still being planned.
 *
 * IT IS BOUGHT EVERY BEAT AFTER THAT, and that is a deliberate cost rather than
 * an oversight. The cheap alternative -- prefilter on the commit ledger and only
 * scan when it complains -- does not work: the ledger cannot see a fast-forward,
 * so under this repo's merge policy it complains about every delivered card and
 * the prefilter saves nothing while being wrong. One scan per epic per beat, at a
 * 45-second cadence, bounded at 15s, is the honest price of a gate that parks
 * runs. If it ever needs to be cheaper, the fabric is a per-PROJECT fact and
 * belongs in the sweep's pre-pass beside `queue` and `headroom` -- computed once
 * per tick and shared by every epic in the project.
 */
export function wantsFabric(cards: readonly ProjectTaskMeta[], epicId: string): boolean {
  return childrenOf(cards, epicId).some(c => DELIVERING_LANES.has(c.status))
}
