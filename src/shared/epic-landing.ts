/**
 * HAS THIS CARD'S WORK ACTUALLY LANDED? -- the rule, with no IO in it.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  A CARD WHOSE BRANCH HAS NO CLOSING COMMIT ON main IS UNSETTLED FOR THE   ┃
 * ┃  PURPOSES OF MOVING THE RUN FORWARD. `done` IS A LANE, NOT A GIT FACT.    ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * WHY THIS EXISTS. On 2026-08-22, 34 `worktree-epic/*` branches sat unmerged from
 * runs whose cards all read `done`. Merging was PROMPT TEXT -- `epic-orders.ts`
 * tells the werk-master it "merges", and the engine performed none and verified
 * none. `run.target` was prompt text too: it reached exactly two prompt builders
 * and nothing in the engine branched on it. The engine already KNEW, in
 * `epic-promise.ts`, and threw the fact away by design ("IT NEVER BLOCKS").
 *
 * The consequence worse than a stranded branch: `depends_on` means "must reach
 * `done` before this one is ready". If `done` does not imply merged, a dependent
 * card dispatches onto a base MISSING its dependency's work -- so the next worker
 * either redoes it or builds on sand. That is silently corrupted sequencing,
 * invisible because every card says `done`.
 *
 * THE RULE IS DERIVED, NEVER STORED. Everything here is a pure function of facts
 * the beat re-reads every time: the commit ledger's answer for the branch, and
 * whether a worktree still holds it. A second copy of merged-ness in `run.md`
 * would be a mirror of a fact that lives in git -- and this engine deleted
 * exactly such a mirror on 2026-08-22 after a stale generation mirror cost
 * `epic-the-wall-ii` hours of `stale wake: expected gen 12, epic is at gen 11`.
 * A stale `unmerged:` entry on a card that has since merged is a run that refuses
 * to move forever and needs a human to hand-edit an artifact to free it.
 *
 * WHAT *IS* PERSISTED lives elsewhere and is not derivable: which cards the
 * werk-master has already been woken about, and at which generation
 * (`EpicRunMeta.unlandedWoken`). That is what stops an infinite wake loop and
 * what makes "park if it is STILL unmerged after the werk-master ran for it" a
 * decidable question rather than a guess.
 */

import type { EpicRunTarget } from './epic-run-types'

/**
 * WHAT THE COMMIT LEDGER FOUND for a card's branch, in the vocabulary of this
 * module rather than of `commit-ledger/branch.ts`.
 *
 * Re-spelled rather than imported because that resolver lives in `src/broker` and
 * this file is `src/shared` -- the boundary is real (`bun run lint:boundary`) and
 * a type-only import across it would still be an import. The broker maps its
 * `BranchResolution` onto these three words in one place (`epic-landing.ts`).
 *
 *   `merged`     a commit on the repo's own trunk whose subject names the branch.
 *                It IS on main by construction.
 *   `committed`  commits recorded ON the branch and nothing on the trunk. Real,
 *                attributed work that has not reached main.
 *   `none`       the ledger has never heard of the branch.
 */
export type LandingEvidence = 'merged' | 'committed' | 'none'

/**
 * WHERE A `done` CARD'S WORK ACTUALLY IS.
 *
 *   `landed`    the run's `target` is satisfied and nothing is left standing.
 *   `unmerged`  the work exists on a branch and is NOT on main. THIS is the one
 *               that corrupts sequencing, so it is the one that holds dependents.
 *   `standing`  the commit is on main and THE BRANCH IS STILL THERE. A branch
 *               merged but left behind is half a resolution: RESOLVED MEANS
 *               MERGED **AND** CLEANED UP -- the commit on main, the worktree
 *               removed, the branch gone. `worktree-remove.sh` does all three and
 *               REFUSES while unmerged commits exist, so "the branch is no longer
 *               a local ref" is itself evidence the removal ran and was allowed
 *               to. That refusal is the verifier for this half, and nothing here
 *               re-checks merged-ness to second-guess it.
 *   `unknown`   nobody could answer. NOT a synonym for either of the above, and
 *               that distinction is the whole safety property of this gate -- see
 *               {@link landingVerdict}.
 */
export type LandingVerdict = 'landed' | 'unmerged' | 'standing' | 'unknown'

/** One card's answer, with everything a prompt or a baton entry needs to say it
 *  out loud. The branch rides along because "go and merge it" is useless advice
 *  without the branch name, and the card id alone does not spell one. */
export interface CardLanding {
  cardId: string
  /** `worktree-epic/<epic>/<card>` -- `cardBranch`, resolved by the caller. */
  branch: string
  verdict: LandingVerdict
  evidence: LandingEvidence
}

/** The facts one verdict is computed from. All of them are re-read every beat. */
export interface LandingFacts {
  /**
   * Could the commit ledger answer AT ALL this beat? `commits.db` may not be
   * open (a broker with no ledger, a fresh install, a test).
   *
   * SEPARATE FROM `evidence: 'none'` ON PURPOSE. Folding "the ledger is not
   * there" into "the ledger found nothing" would make every card in every run
   * read `unmerged` the moment the database went away, and this gate holds
   * dispatch -- so a missing ledger would freeze every epic on the box.
   */
  ledgerReady: boolean
  evidence: LandingEvidence
  /**
   * IS THIS BRANCH STILL A LOCAL REF? `null` MEANS NOBODY LOOKED.
   *
   * THE BRANCH AND NOT THE WORKTREE, because the branch is the thing the fabric
   * scan actually enumerates (`for-each-ref refs/heads`, `git-fabric.ts`) and
   * because it is the STRICTER of the two: `worktree-remove.sh` removes the
   * worktree and deletes the branch together, so a surviving ref means the
   * cleanup did not run or was refused. A branch with no worktree still fails
   * this, which is right -- "the branch is gone" is half the definition of
   * resolved.
   *
   * `null` follows `GitDirt.known`'s convention one layer down: the scan is a
   * sentinel round trip with a 15s ceiling, and the beat only buys it when
   * cleanliness can change an outcome. "We could not look" must never read as
   * "there is nothing there".
   *
   * THE SCAN IS CAPPED (`MAX_BRANCHES`), so a repo with hundreds of branches can
   * report a surviving branch as absent. That errs toward `landed` -- the run
   * finishes rather than freezing on a truncated scan -- which is the only
   * direction a capped read may safely fail in.
   */
  branchStanding: boolean | null
  /** The run's delivery rung. READ BY THE ENGINE, at last. */
  target: EpicRunTarget
}

/**
 * THE VERDICT. Two refusals to guess, then the target ladder.
 *
 * WHY `none` IS `unknown` AND NOT `unmerged`. A `done` card whose branch the
 * ledger has never seen is most often a card that never had a branch at all -- a
 * question card the werk-master answered, a decision recorded on the board, a
 * card closed as already-done by the werk-planner. Calling those unmerged would
 * freeze a run over work that was never supposed to produce a commit, and the
 * failure this gate exists to catch does not look like that: the 34 stranded
 * branches all had commits on them (`committed`), which is exactly what this
 * catches. So the gate is deliberately quiet where it cannot tell, and loud where
 * it can.
 *
 * WHY `pr` ACCEPTS `committed`. The commit ledger is a post-commit hook: it
 * records commits, and it cannot see a push. `committed` is therefore the
 * strongest evidence this engine holds for a run whose rung is "there is a branch
 * to open a PR from", and pretending otherwise would make `target=pr` unusable.
 * Stated rather than quietly rounded off, because a reader will otherwise assume
 * the gate verified a remote.
 *
 * WHY `pr` SKIPS THE CLEANUP HALF. `worktree-remove.sh` refuses to remove a
 * worktree while unmerged commits exist -- which for a `pr` run is the NORMAL
 * state, by definition of the rung. Requiring cleanup there would demand a
 * removal the verifier is built to refuse, and the branch has to survive anyway:
 * it is the thing the PR is opened from.
 *
 * `shipped` is treated as `merged`. The engine cannot verify a deploy; what it
 * can verify is the subset every shipped thing must first satisfy, and claiming
 * more than that would be the exact "could not verify folded into delivered" the
 * promise ledger refuses.
 */
export function landingVerdict(facts: LandingFacts): LandingVerdict {
  if (!facts.ledgerReady || facts.evidence === 'none') return 'unknown'
  if (facts.target === 'pr') return 'landed'
  if (facts.evidence === 'committed') return 'unmerged'
  return facts.branchStanding === true ? 'standing' : 'landed'
}

/**
 * Does this verdict WITHHOLD THIS CARD'S DEPENDENTS from dispatch?
 *
 * `unmerged` ONLY, and the narrowness is the design. A dependent's problem is
 * that the code it was sequenced to build on is not in its base; a merged branch
 * whose worktree nobody deleted is untidy, and its code is in main. Holding
 * dependents on tidiness would stop a run for a `rm -rf`.
 */
export function holdsDependents(verdict: LandingVerdict): boolean {
  return verdict === 'unmerged'
}

/**
 * Does this verdict stop the RUN being finished -- completion refused, the
 * werk-master woken, and eventually a park?
 *
 * BOTH FAILING VERDICTS, because RESOLVED MEANS MERGED **AND** CLEANED UP: the
 * card's commit is on main, the worktree is removed, the branch is gone. A run
 * that reaches `complete` with worktrees still standing has not completed.
 */
export function blocksResolution(verdict: LandingVerdict): boolean {
  return verdict === 'unmerged' || verdict === 'standing'
}

/** The blocking subset, in card order -- what every caller here actually wants. */
export function unresolvedLandings(landings: readonly CardLanding[]): CardLanding[] {
  return landings.filter(l => blocksResolution(l.verdict))
}

/** One card, in a sentence a werk-master can act on without asking anything else. */
export function describeLanding(l: CardLanding): string {
  return l.verdict === 'standing'
    ? `${l.cardId} -- \`${l.branch}\` IS on main, but the branch and its worktree are still standing; run ` +
        '`scripts/worktree-remove.sh`, which fast-forwards first and REFUSES while anything is unmerged'
    : `${l.cardId} -- \`${l.branch}\` has commits that are NOT on main; the card says \`done\` and the work ` +
        'is not delivered'
}

/**
 * WHICH CARDS THE WERK-MASTER HAS ALREADY BEEN WOKEN ABOUT, AND AT WHICH
 * GENERATION -- parsed from the one scalar this feature persists.
 *
 * A STRING, not an array, because `EpicBeatPatch` is pruned by scalar inequality
 * (`pruned`, epic-beat.ts): an array field would compare unequal to itself on
 * every beat and write `run.md` every 45 seconds forever. Sorted and joined so
 * the same set always serialises to the same bytes, which is what makes that
 * comparison mean anything.
 *
 * Format: `card-a@3,card-b@7`. Unparseable entries are DROPPED rather than
 * guessed at -- a hand-edited run.md costs at most one extra wake.
 */
export function parseEscalations(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>()
  for (const entry of (raw ?? '').split(',')) {
    const at = entry.lastIndexOf('@')
    if (at <= 0) continue
    const gen = Number(entry.slice(at + 1))
    if (Number.isInteger(gen) && gen >= 0) out.set(entry.slice(0, at).trim(), gen)
  }
  return out
}

/** The inverse. Sorted by card id so the bytes are a function of the set alone. */
export function formatEscalations(map: ReadonlyMap<string, number>): string {
  return [...map]
    .map(([cardId, gen]) => `${cardId}@${gen}`)
    .sort()
    .join(',')
}
