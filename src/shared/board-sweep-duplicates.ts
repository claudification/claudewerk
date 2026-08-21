/**
 * THE DUPLICATE PREFILTER -- a cheap, pure pass that decides what the model is
 * ever allowed to look at.
 *
 * The board is ~600 cards, so the cross product is ~180k pairs. Handing that to a
 * model is not a cost problem, it is a DESIGN problem: a pass whose price scales
 * with the square of the board is a pass that gets switched off within a week,
 * and a switched-off duplicate check reports zero duplicates forever while
 * looking healthy. So the model never sees pairs; it sees a SHORTLIST, capped,
 * with the cap reported rather than applied quietly.
 *
 * Two signals, both computed from what the board already carries:
 *
 *   TITLE  token Jaccard on the normalised title. Near-identical titles are how
 *          the real duplicates on this board actually look -- the same card filed
 *          twice by two agents, hours apart, with one word different.
 *   TAGS   Jaccard on the tag set. On its own it is worthless (half the board is
 *          `[werk]`), so it only ever RESCUES a pair whose titles are related but
 *          not near-identical.
 *
 * WHAT IT WILL NOT PAIR: two cards that are both filed (`done`/`archived`). Two
 * finished cards overlapping is a fact about history that nobody can act on, and
 * on this board it is the overwhelming majority of the cross product. A live card
 * against a finished one still pairs -- that one means "you are about to rebuild
 * something".
 */

import type { ProjectTaskMeta } from './project-task-types'
import { isFiledLane } from './promise-ledger'

/** Titles this close (token Jaccard) are a pair on their own. */
export const TITLE_NEAR = 0.6
/** Below this, no tag overlap can rescue the pair -- the titles are unrelated. */
export const TITLE_FLOOR = 0.3
/** Tag overlap that rescues a merely-related pair. */
export const TAG_NEAR = 0.5

/**
 * How many pairs the model is ever shown in one sweep.
 *
 * Forty, because the report is read at 08:00 by one human: a duplicate section
 * longer than a screen is a section that gets scrolled past, and the cap keeps
 * the model pass a fixed cost regardless of how large the board grows. Overflow
 * is REPORTED (`board-sweep.ts` refuses the dropped cards into a named bucket),
 * never dropped silently -- a truncated list that looks complete is the failure
 * this whole scanner contract exists to stop.
 */
export const MAX_DUPLICATE_PAIRS = 40

/** One pair worth a model's attention, with the numbers that got it here. */
export interface DuplicateCandidate {
  /** The two card slugs, always in sorted order so a pair has ONE identity. */
  a: string
  b: string
  /** Sort key: title similarity, 0..1. Also what the cap sorts on. */
  score: number
  /** Everything the model needs to judge, so the caller never re-reads cards. */
  aTitle: string
  bTitle: string
  aPreview: string
  bPreview: string
}

/** The model's answer for one pair. */
export interface DuplicateJudgement {
  a: string
  b: string
  duplicate: boolean
  /** 0..1, a sort key for the section and nothing else. */
  confidence: number
  reason: string
}

/**
 * The model pass, INJECTED. Absent means no model is wired, which is a legal and
 * fully-tested state: the sweep still returns its two fact-kinds and says out
 * loud that the duplicate half did not run.
 */
export type DuplicateJudge = (shortlist: readonly DuplicateCandidate[]) => Promise<readonly DuplicateJudgement[]>

/** Lowercased alphanumeric tokens. Punctuation and case are noise here -- the
 *  same card filed twice differs by a colon as often as by a word. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 0),
  )
}

/** |A n B| / |A u B|. Two empty sets are 0, not 1: "neither has tags" is not
 *  evidence of anything, and scoring it 1 would pair the whole untagged board. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** The pair rule, on its own so it can be tested without building a board. */
export function pairsAsDuplicateCandidate(titleSim: number, tagSim: number): boolean {
  if (titleSim >= TITLE_NEAR) return true
  return titleSim >= TITLE_FLOOR && tagSim >= TAG_NEAR
}

interface Printed {
  card: ProjectTaskMeta
  title: Set<string>
  tags: Set<string>
}

function print(card: ProjectTaskMeta): Printed {
  return { card, title: tokens(card.title), tags: new Set(card.tags.map(t => t.toLowerCase())) }
}

/** The full prefilter result: what the model should see, and what the cap ate. */
export interface Shortlist {
  /** At most `MAX_DUPLICATE_PAIRS`, highest score first. */
  pairs: DuplicateCandidate[]
  /** Pairs the cap dropped, highest score first. Reported, never hidden. */
  overflow: DuplicateCandidate[]
}

/**
 * Every candidate pair on the board, capped.
 *
 * O(n^2) in card count and deliberately so: it is set intersection on short
 * token sets, ~180k of them, which is milliseconds. The thing that had to be
 * bounded is the MODEL pass, and that is what the cap bounds.
 */
export function shortlistDuplicates(cards: readonly ProjectTaskMeta[], cap = MAX_DUPLICATE_PAIRS): Shortlist {
  const printed = cards.map(print)
  const candidates: DuplicateCandidate[] = []

  for (let i = 0; i < printed.length; i += 1) {
    for (let j = i + 1; j < printed.length; j += 1) {
      const left = printed[i]
      const right = printed[j]
      // Both finished: history, not a decision. See the header.
      if (isFiledLane(left.card.status) && isFiledLane(right.card.status)) continue
      const titleSim = jaccard(left.title, right.title)
      if (!pairsAsDuplicateCandidate(titleSim, jaccard(left.tags, right.tags))) continue
      const [a, b] = left.card.slug < right.card.slug ? [left.card, right.card] : [right.card, left.card]
      candidates.push({
        a: a.slug,
        b: b.slug,
        score: titleSim,
        aTitle: a.title,
        bTitle: b.title,
        aPreview: a.bodyPreview,
        bPreview: b.bodyPreview,
      })
    }
  }

  // Score first, then pair identity: a tie must not resolve by array order, or
  // the same board hands the model a different shortlist on a reordered read.
  candidates.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
  return { pairs: candidates.slice(0, cap), overflow: candidates.slice(cap) }
}
