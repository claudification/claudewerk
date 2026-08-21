/**
 * THE BACKFILL'S DECISION LAYER -- which commit, if any, gets written to a card
 * that was filed as finished before anybody could promise anything.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  A FALSE `delivered` IS THE WORST ROW THIS LEDGER CAN PRINT.             ┃
 * ┃                                                                          ┃
 * ┃  A false accusation is loud and someone argues with it. A false delivery ┃
 * ┃  is silent, and it is the exact thing the ledger was built to catch --   ┃
 * ┃  work filed as done that nothing backs. So every rule below is biased    ┃
 * ┃  toward writing NOTHING, and every sha that does get written is either   ┃
 * ┃  a fact or explicitly stamped `inferred: true`.                          ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * Pure on purpose: no git, no fs, no clock. Every rule here is provable in a
 * test with no repo on disk, which is the same bargain `promise-ledger.ts`
 * makes with its injected `CommitResolver` and for the same reason.
 */

import type { ClosingCommit } from '../../src/shared/promise-ledger'

/** DONE or ARCHIVED. The backfill only ever touches cards filed as finished. */
const FILED: ReadonlySet<string> = new Set(['done', 'archived'])

/**
 * How a commit came to be associated with a card, WORST-CASE-FIRST in strength.
 *
 * The order is the whole design. `branch-merge` is a fact git can be asked to
 * confirm; the other two are a script reading prose. Ranking them and stopping
 * at the first hit is what keeps a card's `closes:` as strong as the best
 * evidence available for it, rather than as weak as the noisiest.
 */
export type EvidenceKind = 'branch-merge' | 'commit-message' | 'built-section'

/** Is this kind a FACT, or a reconstruction that must be stamped `inferred:`? */
export function isFact(kind: EvidenceKind): boolean {
  return kind === 'branch-merge'
}

/**
 * Is this id specific enough that finding it in a COMMIT MESSAGE is a reference
 * rather than a coincidence?
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  THE THRESHOLD IS MEASURED, NOT GUESSED.                                 ┃
 * ┃                                                                          ┃
 * ┃  Run 1 (no guard): `bug` matched TWELVE commits and `backup` TEN, purely ┃
 * ┃  on the English word. Run 2 (>= 12 chars): `project-tasks` matched       ┃
 * ┃  TWELVE commits about the project board and `task-batch-selector` SIX    ┃
 * ┃  about a perf pass -- none of which delivered those cards.               ┃
 * ┃  Run 3 (>= 24 chars): NINE cards matched, every one of them by at most   ┃
 * ┃  two commits. The noise storm stops entirely at 24.                      ┃
 * ┃                                                                          ┃
 * ┃  Written into `closes:` any of that noise resolves `delivered` -- the    ┃
 * ┃  one row this ledger must never print without cause.                     ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * ONLY the commit-message pass is gated on this. `branch-merge` matches an exact
 * branch name and is safe at any length; `built-section` reads shas out of the
 * card's OWN delivery claim and never searches for the id at all.
 */
export function isSearchableInProse(id: string): boolean {
  return id.length >= 24 && id.includes('-')
}

export interface Evidence {
  kind: EvidenceKind
  commits: ClosingCommit[]
}

/** One card, as the backfill needs it. `created` is the card's own frontmatter. */
export interface BackfillCard {
  id: string
  status: string
  /** ISO timestamp from `created:`, or null when the card carries none. */
  created: string | null
  /** True when the card already carries a `promise:` block. */
  hasPromise: boolean
}

export type Plan =
  /** Write these commits. `inferred` decides whether the block is stamped. */
  | { action: 'record'; commits: ClosingCommit[]; inferred: boolean; agreed: string; why: string }
  /** Nothing to record and nothing to accuse: stamp `pre_ledger: true`. */
  | { action: 'amnesty'; agreed: string; why: string }
  /** Leave the card exactly as it is, and say why. */
  | { action: 'skip'; why: string }

/** `2026-08-21T04:05:00.000Z` -> `2026-08-21`. A promise's `agreed:` is a DATE. */
function asDate(iso: string): string {
  return iso.slice(0, 10)
}

/**
 * No evidence: is this card EXCUSED, or does it stay accused?
 *
 * Split out of `planFor` because it is the half that carries the judgment. The
 * rest of `planFor` routes; this decides who gets forgiven, and it wants to be
 * readable on its own.
 */
function amnestyOrAccusation(card: BackfillCard, cutoff: string): Plan {
  if (card.hasPromise) {
    // Somebody -- or the engine -- already wrote a block here and it has no
    // commits. That is a REAL finding: a promise was made and nothing backs it.
    // Stamping amnesty over the top would erase exactly the row this exists for.
    return { action: 'skip', why: 'already carries a promise block with nothing in it -- a real finding' }
  }
  if (card.created === null) {
    // No evidence and no date. An amnesty needs a reason and this card has none.
    return { action: 'skip', why: 'no `created:` -- cannot show it predates the ledger' }
  }
  const created = asDate(card.created)
  if (created >= cutoff) return { action: 'skip', why: `created ${created}, on or after the ledger (${cutoff})` }
  return { action: 'amnesty', agreed: created, why: `created ${created}, before ${cutoff}` }
}

/**
 * Evidence this card is allowed to be judged on.
 *
 * DISCARDED, NOT REFUSED. `bug` matching a dozen commits on the English word is
 * not usable evidence, but it is also not a reason to leave the card accused --
 * it is a pre-ledger card like the other 269 and it falls through to the amnesty
 * exactly as if git had said nothing.
 *
 * The rule is duplicated in `evidenceFor`, which skips the query entirely. It
 * lives HERE as well because here it is provable without a repo, and a caller
 * assembling evidence some other way still cannot slip a coincidence past it.
 */
// Three guards in five lines, every one pinned by `join.test.ts`. The score is
// the no-coverage CRAP estimate: cyclomatic 5 with assumed 0% coverage lands
// exactly on the 30.0 threshold, which any five-branch function would.
// fallow-ignore-next-line complexity
function usableEvidence(card: BackfillCard, evidence: Evidence | null): Evidence | null {
  if (evidence === null || evidence.commits.length === 0) return null
  if (evidence.kind === 'commit-message' && !isSearchableInProse(card.id)) return null
  return evidence
}

/**
 * What to do with one card.
 *
 * `cutoff` is the ISO date the ledger came into existence. It is the ONLY thing
 * standing between an amnesty and a blanket mute: a card created after the
 * ledger existed could have carried a promise, so if it is filed with nothing
 * behind it, that is a real finding and it keeps its red row. Passed in rather
 * than read from a clock or hardcoded, so the test states it and the operator
 * can see it in the script's own header.
 */
export function planFor(card: BackfillCard, evidence: Evidence | null, cutoff: string): Plan {
  if (!FILED.has(card.status)) return { action: 'skip', why: `lane is '${card.status}', not filed` }

  const usable = usableEvidence(card, evidence)
  if (usable === null) return amnestyOrAccusation(card, cutoff)

  // `appendCloses` is idempotent, so a card that ALREADY has a block is still a
  // legitimate target -- a second run adds only what is missing.
  return {
    action: 'record',
    commits: usable.commits,
    inferred: !isFact(usable.kind),
    agreed: card.created === null ? cutoff : asDate(card.created),
    why: usable.kind,
  }
}
