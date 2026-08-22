/**
 * One-time promotion of hand-rolled epic linkage to the `epic:` key.
 *
 * Before this, parenthood was written two incompatible ways at once: the epic
 * listed its children in `blocks:` (anvil-epic), and the children named their
 * epic somewhere inside `refs:` alongside file paths and doc links
 * (spawn-unify-*). Neither was read by anything. This reads both and writes the
 * one key that is.
 *
 * `blocks:` is left ON DISK untouched. It still means "runs before" on cards
 * that used it for sequencing, and destroying that while promoting parenthood
 * would lose the only copy. The werk-planner decides later what to strip.
 *
 * Pure planning here (`planEpicMigration`); the CLI does the writing, so the
 * decision table is testable without a board on disk.
 */

import { EPIC_TAG } from './epic-cards'
import type { ProjectTask } from './project-task-types'

export interface EpicAssignment {
  childId: string
  epicId: string
  /** How we knew: the epic listed it, or the child referenced the epic. */
  via: 'parent-blocks' | 'child-refs'
}

export interface EpicMigrationPlan {
  assignments: EpicAssignment[]
  /** Children claimed by two different epics -- never auto-resolved. */
  conflicts: Array<{ childId: string; epicIds: string[] }>
  /** Ids listed as children that no card matches. */
  danglingChildren: string[]
  epicIds: string[]
}

/**
 * Who claims whom, and what that resolves to.
 *
 * Kept as its own type so `planEpicMigration` reads as the three steps it is
 * (collect parent-side, collect child-side, resolve) instead of interleaving
 * the collection rules with the conflict rules.
 */
class Claims {
  private readonly byChild = new Map<string, Map<string, EpicAssignment['via']>>()
  readonly dangling = new Set<string>()

  constructor(private readonly byId: ReadonlyMap<string, ProjectTask>) {}

  add(childId: string, epicId: string, via: EpicAssignment['via']): void {
    if (childId === epicId) return // an epic is not its own child
    if (!this.byId.has(childId)) {
      this.dangling.add(childId)
      return
    }
    const forChild = this.byChild.get(childId) ?? new Map<string, EpicAssignment['via']>()
    // parent-blocks is the stronger signal; never let a refs match downgrade it
    if (!forChild.has(epicId) || via === 'parent-blocks') forChild.set(epicId, via)
    this.byChild.set(childId, forChild)
  }

  resolve(): { assignments: EpicAssignment[]; conflicts: EpicMigrationPlan['conflicts'] } {
    const assignments: EpicAssignment[] = []
    const conflicts: EpicMigrationPlan['conflicts'] = []
    for (const [childId, forChild] of this.byChild) {
      // Already has an epic: that is a human's answer, never overwrite it.
      if (this.byId.get(childId)?.epic) continue
      if (forChild.size > 1) {
        conflicts.push({ childId, epicIds: [...forChild.keys()].toSorted() })
        continue
      }
      const [epicId, via] = [...forChild.entries()][0]
      assignments.push({ childId, epicId, via })
    }
    return { assignments, conflicts }
  }
}

/**
 * Decide who belongs to which epic. `blocksByEpic` is the epic-side list
 * (frontmatter `blocks:`), passed in rather than read off the card because the
 * wire shape deliberately does not carry it.
 */
export function planEpicMigration(
  cards: readonly ProjectTask[],
  blocksByEpic: ReadonlyMap<string, string[]>,
): EpicMigrationPlan {
  const byId = new Map(cards.map(c => [c.slug, c]))
  const epicIds = cards.filter(c => c.tags.includes(EPIC_TAG)).map(c => c.slug)
  const epicSet = new Set(epicIds)

  const claims = new Claims(byId)
  for (const epicId of epicIds) {
    for (const childId of blocksByEpic.get(epicId) ?? []) claims.add(childId, epicId, 'parent-blocks')
  }
  for (const card of cards) {
    if (card.epic) continue // already migrated -- idempotent
    for (const ref of card.refs) {
      if (epicSet.has(ref)) claims.add(card.slug, ref, 'child-refs')
    }
  }

  const { assignments, conflicts } = claims.resolve()

  return {
    assignments: assignments.toSorted((a, b) => a.childId.localeCompare(b.childId)),
    conflicts,
    danglingChildren: [...claims.dangling].toSorted(),
    epicIds: epicIds.toSorted(),
  }
}
