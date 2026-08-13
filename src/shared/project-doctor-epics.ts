/**
 * EPIC INTEGRITY -- parenthood that does not hold up.
 *
 * The generic half of this used to live here: does the target exist, is the
 * card pointing at itself, does the chain loop. That is now ONE pass over every
 * verb in the registry (card-linkage-resolve.ts), because writing it per
 * relation is exactly how `epic:` ended up with a cycle check while
 * `depends_on:` -- the same contradiction -- had none.
 *
 * What is left here is what only EPICS mean: a parent that is not an epic, an
 * epic everyone finished but nobody closed, a dependency reaching across epic
 * boundaries. `checkEpics` still returns the whole board's linkage findings, so
 * it composes the shared pass rather than duplicating it.
 *
 * SEVERITY RULE, and it is the important one: pointing at a card that does not
 * exist YET is a WARNING, never an error. Cards get written out of order all the
 * time -- you sketch the children while the epic is still in your head, or name
 * a sibling you are about to write. A gate that treats a forward reference as a
 * failure teaches people to stop writing links, which costs far more than the
 * dangling reference ever did. Only a contradiction the board cannot resolve --
 * a cycle -- is an error. It is enforced in the resolver, once, for every verb.
 */

import type { CardLinkage } from './card-linkage-read'
import { type LinkedCard, resolveLinkage } from './card-linkage-resolve'
import { EPIC_TAG } from './epic-cards'
import type { DoctorFinding } from './project-doctor-types'
import type { TaskStatus } from './task-statuses'

export interface EpicCardView {
  id: string
  tags: string[]
  status: TaskStatus
  /** `epic:` frontmatter -- the parent this card claims. */
  epic?: string
  /** `depends_on:` frontmatter -- siblings this card waits on. */
  dependsOn: string[]
  /** The card's FULL linkage bag, aliases folded (`readLinkage()` output). The
   *  doctor passes it so every verb is resolved; a caller that only cares about
   *  parenthood can leave it out and `epic`/`dependsOn` are used instead. */
  linkage?: CardLinkage
}

const TERMINAL: TaskStatus[] = ['done', 'archived']

/** The check id a ring in `epic:` reports under -- the one finding that
 *  outranks "your parent is not an epic", since a card in a ring has no parent
 *  worth arguing about. */
const EPIC_CYCLE = 'epic-cycle'

function toLinked(card: EpicCardView): LinkedCard {
  if (card.linkage) return { id: card.id, linkage: card.linkage }
  const linkage: CardLinkage = {}
  if (card.epic) linkage.epic = [card.epic]
  if (card.dependsOn.length > 0) linkage.depends_on = card.dependsOn
  return { id: card.id, linkage }
}

function childrenOf(cards: readonly EpicCardView[], epicId: string): EpicCardView[] {
  return cards.filter(c => c.epic === epicId)
}

function notAnEpicFinding(card: EpicCardView, epicId: string): DoctorFinding {
  return {
    check: 'epic-not-an-epic',
    severity: 'warning',
    subject: card.id,
    problem: `claims epic "${epicId}", a card with no \`${EPIC_TAG}\` tag`,
    remedy: `add \`${EPIC_TAG}\` to that card's tags, or point this at the real epic`,
  }
}

function staleFinding(card: EpicCardView, total: number): DoctorFinding {
  return {
    check: 'epic-stale',
    severity: 'info',
    subject: card.id,
    problem: `all ${total} children are done or archived, but the epic is still \`${card.status}\``,
    remedy: `move it to done, or say in the body what is still outstanding`,
  }
}

/** A dependency leaving the epic. Legitimate often enough that it is info, but
 *  it is also what a mistyped `epic:` looks like from the other side. */
function dependsOutsideFindings(card: EpicCardView, byId: ReadonlyMap<string, EpicCardView>): DoctorFinding[] {
  if (!card.epic) return []
  const out: DoctorFinding[] = []
  for (const dep of card.dependsOn) {
    const target = byId.get(dep)
    if (!target?.epic || target.epic === card.epic) continue
    out.push({
      check: 'epic-depends-outside',
      severity: 'info',
      subject: card.id,
      problem: `waits on "${dep}", which belongs to a different epic ("${target.epic}")`,
      remedy: `expected for a genuine cross-epic dependency -- otherwise one of the two epic: keys is wrong`,
    })
  }
  return out
}

/**
 * What only epics mean. `cyclic` is the set of cards the resolver already found
 * a ring for: telling somebody their parent lacks a tag, when the real problem
 * is that the parenthood loops, is a second finding on one root cause.
 */
function parenthoodFindings(
  card: EpicCardView,
  byId: ReadonlyMap<string, EpicCardView>,
  cyclic: ReadonlySet<string>,
): DoctorFinding[] {
  const parent = card.epic ? byId.get(card.epic) : undefined
  if (!parent || cyclic.has(card.id) || parent.tags.includes(EPIC_TAG)) return []
  return [notAnEpicFinding(card, card.epic as string)]
}

/** An epic nobody closed. Only asked of a card that IS one and is still open,
 *  which is why it is the last thing computed rather than the first. */
function staleFindings(card: EpicCardView, cards: readonly EpicCardView[]): DoctorFinding[] {
  if (!card.tags.includes(EPIC_TAG) || TERMINAL.includes(card.status)) return []
  const kids = childrenOf(cards, card.id)
  if (kids.length === 0 || !kids.every(k => TERMINAL.includes(k.status))) return []
  return [staleFinding(card, kids.length)]
}

function epicSemantics(cards: readonly EpicCardView[], cyclic: ReadonlySet<string>): DoctorFinding[] {
  const byId = new Map(cards.map(c => [c.id, c]))
  return cards.flatMap(card => [
    ...parenthoodFindings(card, byId, cyclic),
    ...dependsOutsideFindings(card, byId),
    ...staleFindings(card, cards),
  ])
}

/** Every linkage problem on the board: the shared resolve pass over every verb,
 *  plus the epic-only semantics above. */
export function checkEpics(cards: readonly EpicCardView[]): DoctorFinding[] {
  const resolved = resolveLinkage(cards.map(toLinked))
  const cyclic = new Set(resolved.filter(f => f.check === EPIC_CYCLE).map(f => f.subject))
  return [...resolved, ...epicSemantics(cards, cyclic)]
}
