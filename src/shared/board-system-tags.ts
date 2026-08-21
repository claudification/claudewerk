/**
 * SYSTEM TAGS -- the tags the machinery reads, in the order a human should see
 * them.
 *
 * A board tag is normally just a label. A handful of them are ROUTING: something
 * in the engine changes behaviour because the tag is present. Those were
 * scattered -- `epic` lived in `epic-cards.ts`, `needs-overseer` was a bare
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
 * `needs-refine` leads because it is the one a human applies BY HAND while
 * capturing; the other two are usually written by the engine or by the act of
 * creating an epic, so a picker offering them first would be offering the rarer
 * case.
 */
export const SYSTEM_TAGS: readonly SystemTag[] = [
  { tag: 'needs-refine', detail: 'filed rough -- improve it later' },
  { tag: EPIC_TAG, detail: 'this card IS an epic' },
  { tag: 'needs-overseer', detail: 'a question for the overseer, not work' },
] as const
