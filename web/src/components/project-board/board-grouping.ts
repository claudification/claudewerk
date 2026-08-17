/**
 * Grouping the lanes -- the fold that replaced the LANES/EPICS mode toggle.
 *
 * An epic is not a different SCREEN, it is a way of arranging the cards the
 * board already holds. Modelling it as a second view meant the two could
 * disagree, meant drag-and-drop and the filters only worked on one of them, and
 * meant answering "how does this epic relate to that lane" required holding
 * both in your head. Grouping answers it by never separating them.
 *
 * Pure over cards the board already has: no I/O, one `useMemo`, and the lane
 * cards and the EPICS view read the same numbers by construction.
 */

import type { EpicRollup } from '@shared/epic-cards'
import type { ProjectTaskMeta } from '@shared/project-task-types'

export type GroupBy = 'none' | 'epic' | 'tag' | 'priority'

export const GROUP_BY_OPTIONS: GroupBy[] = ['none', 'epic', 'tag', 'priority']

/** The bucket for cards that have nothing to group by. Always sorts LAST. */
export const UNGROUPED_KEY = ''

export interface CardGroup {
  /** Stable identity. `UNGROUPED_KEY` for the leftovers bucket. */
  key: string
  label: string
  /** Set only when this group IS an epic -- what the rail and mark read. */
  epicId?: string
  cards: ProjectTaskMeta[]
}

/** What a card groups under, or null for "no such thing on this card". */
type KeyOf = (card: ProjectTaskMeta, ctx: GroupContext) => string | null

interface GroupContext {
  /** Board-wide tag frequency, so tag grouping clusters on the common tag. */
  tagRank: Map<string, number>
  index: Map<string, EpicRollup>
}

/**
 * A card's epic is the one it points at -- or itself, when the card IS an epic.
 * An epic card grouped anywhere but at the head of its own group reads as an
 * unrelated card that happens to share a colour.
 */
const byEpic: KeyOf = (card, ctx) => card.epic ?? (ctx.index.has(card.slug) ? card.slug : null)

/**
 * The card's most board-common tag, not its first.
 *
 * "First" is whatever order the frontmatter happened to be written in, which
 * scatters cards that belong together. Ranking by how often a tag appears on
 * the whole board puts a `refactor`-and-`web` card with the other `refactor`
 * work, which is the cluster someone triaging is actually looking for.
 */
const byTag: KeyOf = (card, ctx) => {
  let best: string | null = null
  let bestRank = -1
  for (const tag of card.tags) {
    const rank = ctx.tagRank.get(tag) ?? 0
    if (rank > bestRank) {
      best = tag
      bestRank = rank
    }
  }
  return best
}

const byPriority: KeyOf = card => card.priority ?? null

const KEY_OF: Record<GroupBy, KeyOf> = {
  none: () => null,
  epic: byEpic,
  tag: byTag,
  priority: byPriority,
}

/** Label for the leftovers bucket -- names what is missing, not what is wrong. */
const UNGROUPED_LABEL: Record<GroupBy, string> = {
  none: 'all',
  epic: 'no epic',
  tag: 'no tags',
  priority: 'no priority',
}

/** Priority is an order, not an alphabet. */
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

function labelFor(groupBy: GroupBy, key: string, ctx: GroupContext): string {
  if (groupBy !== 'epic') return key
  return ctx.index.get(key)?.card?.title ?? key
}

/**
 * Sort groups so the one someone wants is first and the leftovers are last.
 *
 * Epics sort by outstanding work (the same "urgency" the EPICS view uses),
 * priority by its own rank, tags by size. `UNGROUPED_KEY` always sinks --
 * on a board mid-adoption it is the biggest group, and floating it to the top
 * would bury every organised group under it.
 */
function compareGroups(groupBy: GroupBy, a: CardGroup, b: CardGroup, ctx: GroupContext): number {
  if (a.key === UNGROUPED_KEY) return 1
  if (b.key === UNGROUPED_KEY) return -1
  if (groupBy === 'priority') {
    return (PRIORITY_RANK[a.key] ?? 99) - (PRIORITY_RANK[b.key] ?? 99)
  }
  if (groupBy === 'epic') {
    const ra = ctx.index.get(a.key)
    const rb = ctx.index.get(b.key)
    const outstanding = (r?: EpicRollup) => (r ? r.notStarted + r.inProgress : 0)
    const diff = outstanding(rb) - outstanding(ra)
    if (diff !== 0) return diff
  }
  return b.cards.length - a.cards.length || a.key.localeCompare(b.key)
}

export function tagFrequencyRank(cards: readonly ProjectTaskMeta[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const card of cards) {
    for (const tag of card.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return counts
}

/**
 * Cards folded into groups, ordered, leftovers last.
 *
 * `groupBy: 'none'` returns a single unlabelled group so a caller never has to
 * branch on "is this grouped" -- it renders groups either way and the group bar
 * hides itself when there is only the one.
 */
export function groupCards(
  cards: readonly ProjectTaskMeta[],
  groupBy: GroupBy,
  index: Map<string, EpicRollup>,
  tagRank: Map<string, number>,
): CardGroup[] {
  const ctx: GroupContext = { tagRank, index }
  const keyOf = KEY_OF[groupBy] ?? KEY_OF.none
  const byKey = new Map<string, CardGroup>()

  for (const card of cards) {
    const key = keyOf(card, ctx) ?? UNGROUPED_KEY
    const existing = byKey.get(key)
    if (existing) {
      existing.cards.push(card)
      continue
    }
    byKey.set(key, {
      key,
      label: key === UNGROUPED_KEY ? UNGROUPED_LABEL[groupBy] : labelFor(groupBy, key, ctx),
      epicId: groupBy === 'epic' && key !== UNGROUPED_KEY ? key : undefined,
      cards: [card],
    })
  }

  return [...byKey.values()].sort((a, b) => compareGroups(groupBy, a, b, ctx))
}
