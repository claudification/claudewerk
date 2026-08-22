/**
 * THE ENGINE HALF of the landing gate: which card, which branch, and what git
 * actually says about it.
 *
 * `src/shared/epic-landing.ts` is the RULE -- pure, targetted, and the only place
 * `pr` vs `merged` decides anything. This file is the two lookups behind it, and
 * the cost model that decides whether the second one is worth buying.
 *
 * TWO SOURCES, AND THEY ANSWER DIFFERENT HALVES:
 *
 *   THE COMMIT LEDGER (`commitsForBranch`) answers "is this branch's work on
 *   main". A local indexed read of `commits.db`, synchronous, effectively free --
 *   so it is taken for every terminal card on every beat, which is what makes
 *   merged-ness DERIVED rather than stored.
 *
 *   THE GIT FABRIC (`BeatDeps.gitDirt`) answers "is this still a local branch".
 *   `GitDirt.known` is every ref `for-each-ref refs/heads` returned, so a branch
 *   missing from it is one `worktree-remove.sh` removed -- worktree and ref
 *   together, after the fast-forward it does first and the refusal it raises when
 *   anything is unmerged. That refusal is the cleanup verifier; nothing here
 *   re-derives merged-ness to second-guess it. A sentinel round trip with a
 *   15-second ceiling, so it is bought only on the beats where the answer can
 *   change an outcome -- see `wantsFabric`.
 *
 * NOTHING HERE MERGES ANYTHING, and that is the boundary rather than an omission:
 * the broker is a broker, the sentinel owns the filesystem and git, and the
 * werk-master seat is the party whose job the merge is. The engine CHECKS. What
 * this file produces is a fact; what the beat does with it (hold, escalate, park)
 * lives in `epic-beat.ts`.
 */

import { type CardLanding, type LandingEvidence, landingVerdict, unresolvedLandings } from '../shared/epic-landing'
import type { EpicRunTarget } from '../shared/epic-run-types'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { BranchResolution } from './commit-ledger/branch'
import { epicIo } from './epic-io'
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
 * The FILTER LIVES HERE rather than at the two call sites, because a caller that
 * forgot it would ask the commit ledger about `worktree-epic/<this epic>/<some
 * other epic's card>` -- a branch that has never existed, answered `none`,
 * verdict `unknown`, silently harmless and completely wasted. Parenthood is the
 * `epic:` key on the CHILD (epic-cards.ts); there is no parent-side list.
 */
function childrenOf(cards: readonly ProjectTaskMeta[], epicId: string): ProjectTaskMeta[] {
  return cards.filter(c => c.epic === epicId)
}

/** The ledger's vocabulary, in the rule's. One place, so `via` and `evidence`
 *  cannot come to mean different things in two files. */
function evidenceOf(via: BranchResolution | null): LandingEvidence {
  if (via === 'merge') return 'merged'
  return via === 'branch' ? 'committed' : 'none'
}

export interface LandingScope {
  epicId: string
  /** Project URI -- the commit ledger matches it against `repo_uri`/`cwd_uri`. */
  project: string
  /** The run's delivery rung. THE ENGINE READS IT HERE. */
  target: EpicRunTarget
  /**
   * The git fabric's branch list, or `null` when this beat did not buy the round
   * trip.
   *
   * `null` IS "NOBODY LOOKED", and it travels all the way to `landingVerdict` as
   * such. A beat that skipped the scan must not certify a repo it never looked
   * at, and it must not invent a surviving branch either.
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
  const io = epicIo()
  const ledgerReady = io.commitLedgerReady()
  // A fabric that FAILED is the same answer as no fabric at all: unknown. The set
  // is only ever consulted for membership, and an errored scan has no membership
  // to offer -- reading it as "nothing is standing" is precisely how a beat would
  // certify a directory it never opened.
  const standing = scope.fabric?.ok === true ? scope.fabric.known : null

  const out: CardLanding[] = []
  for (const card of childrenOf(cards, scope.epicId)) {
    if (!DELIVERING_LANES.has(card.status)) continue
    const branch = cardBranch(scope.epicId, card.slug)
    const evidence = evidenceOf(io.commitsForBranch(scope.project, branch)?.via ?? null)
    out.push({
      cardId: card.slug,
      branch,
      evidence,
      verdict: landingVerdict({
        ledgerReady,
        evidence,
        branchStanding: standing === null ? null : standing.has(branch),
        target: scope.target,
      }),
    })
  }
  return out
}

/**
 * IS THE 15-SECOND GIT SCAN WORTH BUYING ON THIS BEAT?
 *
 * The cheap half is taken first and answers most beats on its own. The fabric
 * only ever changes a verdict from `landed` to `standing`, which only matters
 * when a run is otherwise FINISHED -- so the trip is bought exactly when the
 * ledger has no complaint left and every child is terminal, which is the beat
 * that would otherwise flip the run to `complete`. A run that never gets there
 * never pays for it.
 *
 * On a healthy run mid-flight the cost is zero. On the beat where it matters it
 * buys the difference between "the board says done" and "the work is in main and
 * nothing is left standing" -- which is the whole claim `complete` makes.
 *
 * A run whose ledger ALREADY has a complaint skips it too, and deliberately:
 * an unmerged branch is escalated on this beat regardless, and the werk-master
 * that fixes it will remove the worktree in the same breath, so the scan would be
 * bought to refine a verdict that is about to be recomputed anyway.
 */
export function wantsFabric(
  cards: readonly ProjectTaskMeta[],
  epicId: string,
  landings: readonly CardLanding[],
): boolean {
  if (unresolvedLandings(landings).length > 0) return false
  // `archived` is dropped from the denominator here exactly as it is in a rollup
  // percentage: an epic whose remaining children were all abandoned is finished,
  // and `childrenComplete` agrees.
  const counted = childrenOf(cards, epicId).filter(c => c.status !== 'archived')
  return counted.length > 0 && counted.every(c => DELIVERING_LANES.has(c.status))
}
