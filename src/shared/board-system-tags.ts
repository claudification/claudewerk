/**
 * SYSTEM TAGS -- the tags the machinery reads, in the order a human should see
 * them.
 *
 * A board tag is normally just a label. A handful of them are ROUTING: something
 * in the engine changes behaviour because the tag is present. Those were
 * scattered -- `epic` lived in `epic-cards.ts`, `needs-werk-master` was a bare
 * string literal in the epic-ready fold, `needs-refine` arrived with the Quick
 * Task capture box -- so nothing could answer "which tags mean something?" and
 * no picker could offer them.
 *
 * ORDER IS THE DISPLAY ORDER. The array is not sorted at render time; a tag
 * picker shows these first, in exactly this sequence, ahead of whatever the
 * board happens to have accumulated. Put the one you reach for most at the top.
 *
 * This is a REGISTRY, not an enforcement point. Nothing here prevents a card
 * carrying an unlisted tag, and nothing here makes a listed tag mandatory -- it
 * only means "the machinery knows this word", which is what earns it the top of
 * a list.
 */

import { EPIC_TAG } from './epic-cards'

export interface SystemTag {
  /** The tag as written on a card, lower-case. */
  tag: string
  /** One line, shown beside it in a picker. Say what READS it, not what it means. */
  detail: string
}

/**
 * The registry, in display order.
 *
 * THE HAND-APPLIED ONES LEAD. `needs-refine`, `nightshift` and `ready` are what a
 * human reaches for while capturing; `epic` and `needs-werk-master` are usually
 * written by the engine or by the act of creating an epic, so a picker offering
 * them first would be offering the rarer case.
 *
 * `nightshift` and `ready` are two tags because they are read by two SCANNERS
 * with two cadences -- "batch this into tonight's run" and "authorised for
 * unattended work, whenever" are different authorisations, and Jonas asked for
 * them as separate opt-in checkboxes. Neither is called `work-order`: that name
 * collides with `order@1`, the ROLE artifact, and "which order does this
 * work-order use?" is an unparseable sentence. Card = the work, tag = the
 * routing, order = the seat.
 *
 * THE LAST TWO ARE DECLARED AND INERT, and that is deliberate. `scanner-ids.ts`
 * names all five scanner ids before four of their scanners exist, for a reason
 * that applies here verbatim: three cards that each append one line to one
 * `const` array run concurrently in three worktrees and produce a guaranteed
 * three-way conflict on a file none of them owns. Naming the whole set once
 * costs nothing and removes the conflict entirely. `werk-verify-by-tag` and
 * `werk-retrospect-hook` bring the BEHAVIOUR; nothing reads either word today,
 * and a `detail` line that claimed otherwise would be the lie this registry
 * exists to prevent ("say what READS it").
 *
 * They sit at the BOTTOM rather than beside `needs-refine`, which is where a
 * hand-applied tag belongs: display order is "reach for this first", and a tag
 * with no consumer is not the one to offer first.
 */
export const SYSTEM_TAGS: readonly SystemTag[] = [
  { tag: 'needs-refine', detail: 'filed rough -- improve it later' },
  { tag: 'nightshift', detail: 'batch this into the next night run' },
  { tag: 'ready', detail: 'authorised for unattended work, whenever' },
  { tag: EPIC_TAG, detail: 'this card IS an epic' },
  { tag: 'needs-werk-master', detail: 'a question for the werk-master, not work' },
  { tag: 'needs-verification', detail: 'declared only -- werk-verify-by-tag brings the behaviour' },
  { tag: 'needs-retrospect', detail: 'declared only -- werk-retrospect-hook brings the behaviour' },
] as const
