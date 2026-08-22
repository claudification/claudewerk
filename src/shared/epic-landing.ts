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
 * THE RULE IS DERIVED, NEVER STORED. Everything here is a pure function of one
 * fact the beat re-reads every time: what git says about the card's branch
 * (`LandingEvidence`). A second copy of merged-ness in `run.md`
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
 * WHAT GIT SAYS ABOUT A CARD'S BRANCH, in the vocabulary of this module rather
 * than of the git-fabric scan that produced it.
 *
 * ONE SOURCE, AND IT IS ANCESTRY. The obvious cheaper source is the commit ledger
 * (`commit-ledger/branch.ts`), which is what the promise ledger uses -- and it is
 * WRONG FOR A GATE. It answers "is there a commit on the trunk whose subject
 * names this branch", i.e. it recognises a MERGE COMMIT. A fast-forward makes no
 * merge commit at all, and `git merge --ff-only` after a rebase is what the
 * werk-master prompt instructs and what this repo does by policy -- so every
 * correctly-delivered card would read "not merged" forever and the run would park
 * on work that is sitting in main. That miss is survivable in the promise ledger,
 * which only ever writes a weaker claim onto a card; it is fatal in a gate.
 *
 * So the question asked is `rev-list --count main..<branch> == 0` -- true for a
 * fast-forward, a no-ff merge, and a rebase-then-ff alike.
 *
 *   `gone`       no local ref for the branch. `worktree-remove.sh` deletes the
 *                worktree and the branch together, fast-forwards first, and
 *                REFUSES while unmerged commits exist -- so an absent ref is
 *                itself evidence the work landed and the cleanup was allowed to
 *                run. That refusal is the verifier; nothing here re-derives
 *                merged-ness to second-guess it.
 *   `merged`     the branch is still a ref, and local main already contains
 *                every commit on it.
 *   `ahead`      the branch carries commits local main does not have.
 *   `unscanned`  nobody looked, or the scan failed.
 *
 * LOCAL main, NOT `origin/main`, for `promise-git.ts`'s stated reason: in this
 * repo local main is the source of truth and origin is a push-only mirror that
 * routinely sits tens of commits behind. Judging against the remote would report
 * every delivered-but-unpushed card as unmerged, in bulk.
 */
export type LandingEvidence = 'gone' | 'merged' | 'ahead' | 'unscanned'

/**
 * WHERE A `done` CARD'S WORK ACTUALLY IS.
 *
 *   `landed`    the run's `target` is satisfied and nothing is left standing.
 *   `unmerged`  the work exists on a branch and is NOT on main. THIS is the one
 *               that corrupts sequencing, so it is the one that holds dependents.
 *   `standing`  main contains the work and THE BRANCH IS STILL THERE. A branch
 *               merged but left behind is half a resolution: RESOLVED MEANS
 *               MERGED **AND** CLEANED UP -- the commit on main, the worktree
 *               removed, the branch gone. `worktree-remove.sh` does all three,
 *               fast-forwards first, and REFUSES while unmerged commits exist.
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

/** The facts one verdict is computed from. Both are re-read every beat. */
export interface LandingFacts {
  evidence: LandingEvidence
  /** The run's delivery rung. READ BY THE ENGINE, at last. */
  target: EpicRunTarget
}

/**
 * THE VERDICT -- a refusal to guess, then the target ladder.
 *
 * WHY `unscanned` IS `unknown`. The scan is a sentinel round trip that can time
 * out, and its result gates DISPATCH. Reading a failed scan as "everything is
 * unmerged" would freeze every epic on the box the moment a sentinel hiccuped;
 * reading it as "everything landed" would silently delete the gate. Neither. "We
 * could not look" is its own answer and it withholds nothing.
 *
 * EVERY OTHER UNCERTAINTY ERRS TOWARD `landed`, on purpose and consistently with
 * the rest of this engine's git reads. `rev-list --count` reports 0 on any
 * failure; the branch walk is capped at `MAX_BRANCHES`, so a surviving branch in
 * a huge repo can read absent; a card that never had a branch at all -- a
 * question the werk-master answered, a card the werk-planner closed as already
 * done -- has no ref and reads `gone`. All three finish the run rather than
 * parking it on evidence nobody has. False open is noise; a false accusation
 * parks a healthy run and is the end of the feature.
 *
 * The one thing it will NOT forgive is a branch that exists and is ahead of main.
 * That is the 34-stranded-branch failure exactly, and it is unambiguous.
 *
 * WHY `pr` IS ALWAYS SATISFIED. The rung means "there is a branch to open a PR
 * from", and this engine cannot see a remote at all -- the fabric answers about
 * local refs and local main. Claiming to have verified a push would be the exact
 * "could not verify folded into delivered" the promise ledger refuses, so `pr`
 * withholds nothing and says so rather than pretending to a check it never ran.
 * It also must not demand the cleanup half: `worktree-remove.sh` refuses while
 * unmerged commits exist, which for a `pr` run is the normal state, and the
 * branch has to survive anyway -- it is what the PR is opened from.
 *
 * `shipped` is treated as `merged`. The engine cannot verify a deploy; what it
 * can verify is the subset every shipped thing must first satisfy.
 */
export function landingVerdict(facts: LandingFacts): LandingVerdict {
  if (facts.evidence === 'unscanned') return 'unknown'
  if (facts.target === 'pr' || facts.evidence === 'gone') return 'landed'
  return facts.evidence === 'merged' ? 'standing' : 'unmerged'
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
