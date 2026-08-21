/**
 * THE OPEN-EPIC ROSTER -- the few lines of board context a refiner needs before
 * it can soft-link the one card it was handed to an epic.
 *
 * `epic:` is declared BY THE CHILD (`project-task-types.ts`), so parenting a
 * card is a one-line edit on the file the refiner already has open. The only
 * thing it was ever missing is knowing which epics exist: a refiner seat is
 * handed ONE card and nothing else, and a Haiku seat on a $0.50 budget will not
 * go and read a 664-card board to find out.
 *
 * PURE FOLD, no fs, no `node:` imports, over cards the caller already holds --
 * the scanner has them from `getCards()` and the panel has them from the store,
 * so nobody pays an extra round trip for this.
 *
 * WHAT IT DELIBERATELY LEAVES OUT:
 *
 *   TERMINAL EPICS. `done` and `archived` epics are excluded: offering a refiner
 *   a finished epic as a parent is offering it the one answer that is certainly
 *   wrong, and the roster is prompt weight on the cheapest seat in the fleet.
 *
 *   EPICS WITH NO CARD OF THEIR OWN. `buildEpicIndex` keeps a rollup for an id
 *   that only children point at (`card: null`) so the doctor can report the
 *   dangling reference. Naming it here would invite a refiner to point a second
 *   card at an id nothing on the board defines -- one dangling ref becoming two.
 *
 *   THE EPIC'S BODY PREVIEW. Cheap signal, and the single thing most likely to
 *   blow the character cap; the id and the title already carry the epic's
 *   subject, and an id chosen from a title is the judgement call the seat is
 *   supposed to be making.
 */

import { buildEpicIndex, epicBucket } from './epic-cards'
import type { ProjectTaskMeta } from './project-task-types'

/** One epic, as the roster sees it. */
export interface EpicRosterEntry {
  id: string
  title: string
  /** Children finished, and children that count toward progress (total minus
   *  dropped) -- the same two numbers an epic's progress bar renders. */
  done: number
  total: number
  /** The epic card's own mtime, the recency the roster orders by. */
  mtime: number
}

/**
 * HOW MANY EPICS MAY BE NAMED, and HOW MANY CHARACTERS THE BLOCK MAY SPEND.
 *
 * Both bounds exist for the same reason: the board grows and the seat does not.
 * An unbounded roster silently doubles the prompt of the cheapest seat in the
 * fleet, and it does it gradually enough that nobody notices the week it
 * happens. The character cap is the real bound -- the count cap just stops a
 * board with 200 short-titled epics from spending the whole budget on ids.
 */
const EPIC_ROSTER_LIMIT = 40
const EPIC_ROSTER_CHAR_BUDGET = 2000

/**
 * Every epic a card could still sensibly be parented to, most recently touched
 * first.
 *
 * RECENCY, NOT CHILD COUNT. An epic nobody has touched in a month is rarely the
 * right parent for a card captured this morning, and child count would rank the
 * board's oldest, fattest epic first forever.
 */
export function openEpics(cards: readonly ProjectTaskMeta[]): EpicRosterEntry[] {
  const entries: EpicRosterEntry[] = []
  for (const rollup of buildEpicIndex(cards).values()) {
    const card = rollup.card
    if (!card) continue
    const bucket = epicBucket(card.status)
    if (bucket === 'done' || bucket === 'dropped') continue
    entries.push({ id: rollup.epicId, title: card.title, done: rollup.done, total: rollup.total, mtime: card.mtime })
  }
  return entries.toSorted((a, b) => b.mtime - a.mtime)
}

/** One epic, one line: the id to copy, the title to judge it by, the progress. */
function epicRosterLine(entry: EpicRosterEntry): string {
  return `- ${entry.id} -- ${entry.title} (${entry.done}/${entry.total})`
}

export interface EpicRosterOptions {
  limit?: number
  charBudget?: number
}

/**
 * THE INSTRUCTION THAT CONSUMES THE ROSTER, written once and imported by both
 * definitions of "refine" -- `REFINER_INSTRUCTIONS` (the scanner seat) and
 * `TASK_MODES.refine` (the panel's batch and single runs). Those two files both
 * carry a header warning about having drifted apart once already; a soft-link
 * step added to one and not the other is exactly that drift, and a step COPIED
 * into both is the same drift with a longer fuse.
 *
 * NUMBERLESS, because the three lists it lands in are different lengths. The
 * caller supplies `N. ` and the continuation lines are indented to match a
 * single-digit number.
 *
 * IT IS PHRASED AS A CONDITIONAL, so it is also correct in the prompts that
 * carry no roster: a card that already has an `epic:` is not sent one (it is
 * prompt weight that changes nothing), and neither is a board with no open
 * epics.
 *
 * "NOT SURE = LEAVE IT UNSET" IS THE WHOLE POINT. A missing `epic:` is a card
 * the epics view lists as unparented, which somebody triages. A WRONG `epic:`
 * is a card that has silently joined another epic's rollup, its lane counts and
 * potentially its engine dispatch, and nothing flags it.
 */
export const EPIC_SOFT_LINK_STEP = `Soft-link it to an epic, but ONLY if you are sure. If an OPEN EPICS list
   appears in this prompt and the card is CLEARLY that epic's work, set
   \`epic: <epic-id>\` in the card's own frontmatter. Not sure? Leave it unset --
   a wrong \`epic:\` drags the card into another epic's rollup and dispatch, which
   is worse than no parent at all. Never edit the epic's own card: parenthood is
   declared by the child`

/** The line the block opens with. EXPORTED so a test can assert the block's
 *  presence without matching the words `OPEN EPICS` inside
 *  {@link EPIC_SOFT_LINK_STEP}, which names the list it is about. */
export const EPIC_ROSTER_HEADER = 'OPEN EPICS on this board -- candidate parents, by `epic:` id:'

/**
 * SHOULD THIS RUN CARRY A ROSTER AT ALL -- the rule, written once for all three
 * surfaces that ask it (the scanner seat, the panel's single refine, the
 * panel's batch refine).
 *
 * Two conditions, and both are about not spending prompt on a block nobody can
 * act on. It has to be a REFINE: no other mode is instructed to parent anything,
 * and a work run that quietly re-parented its card would be a card moving epics
 * with nobody deciding it. And at least one card in the run has to be an ORPHAN:
 * a refiner ADDS a missing parent, it does not re-home a card that has one.
 *
 * `isRefine` is a boolean rather than a `TaskMode` because `task-modes.ts`
 * imports this module for {@link EPIC_SOFT_LINK_STEP}, and the mode union is
 * only one of the three callers' vocabulary anyway.
 */
export function wantsEpicRoster(isRefine: boolean, targets: readonly Pick<ProjectTaskMeta, 'epic'>[]): boolean {
  return isRefine && targets.some(t => !t.epic)
}

/**
 * The roster as a prompt block, or `''` when the board has no open epic.
 *
 * TRUNCATION IS ANNOUNCED, never silent. A roster that quietly stops at 40 reads
 * to the seat as "these are all the epics there are", and the seat then decides
 * the card belongs to none of them -- a wrong answer produced with confidence.
 * The trailing count says how many it did not see.
 */
export function openEpicRoster(cards: readonly ProjectTaskMeta[], opts: EpicRosterOptions = {}): string {
  const limit = opts.limit ?? EPIC_ROSTER_LIMIT
  const charBudget = opts.charBudget ?? EPIC_ROSTER_CHAR_BUDGET
  const all = openEpics(cards)
  if (all.length === 0) return ''

  const lines: string[] = []
  let spent = EPIC_ROSTER_HEADER.length
  for (const entry of all.slice(0, Math.max(0, limit))) {
    const line = epicRosterLine(entry)
    // +1 for the newline this line costs. Budget is checked BEFORE the push, so
    // the block never exceeds it -- an "almost fits" line is dropped, not
    // trimmed into an id that resolves to nothing.
    if (spent + line.length + 1 > charBudget) break
    lines.push(line)
    spent += line.length + 1
  }
  if (lines.length === 0) return ''

  const omitted = all.length - lines.length
  if (omitted > 0) lines.push(`- ...and ${omitted} more open epic(s) not listed here`)
  return [EPIC_ROSTER_HEADER, ...lines].join('\n')
}
