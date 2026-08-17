/**
 * WHAT A BOARD CARD IS, epic-wise -- the one decision, made once.
 *
 * `isEpicCard` sat in `epic-cards.ts` exported and tested with ZERO callers,
 * so the kanban board drew an epic exactly like any other card. Only the EPICS
 * view ever knew. That is the whole of the "THE WERK doesn't render as an epic"
 * report: it didn't, because nothing on that surface asked.
 *
 * Pure. The board is a hot path and this runs per card per render, so it stays
 * a couple of map lookups and no allocation beyond the returned role.
 */

import { type EpicRollup, isEpicCard } from '@shared/epic-cards'
import type { ProjectTaskMeta } from '@shared/project-task-types'

export type CardEpicRole =
  /** This card IS an epic. Carries its OWN rollup. */
  | { kind: 'epic'; rollup: EpicRollup }
  /** This card belongs to one. `rollup` is the PARENT's, absent if off-board. */
  | { kind: 'child'; epicId: string; rollup?: EpicRollup }
  | { kind: 'none' }

/**
 * EPIC WINS OVER CHILD, and that ordering is the only subtle thing here. A
 * sub-epic is both; if it read as a child it would wear its parent's colour and
 * an entire branch of the tree would collapse into one hue, which is precisely
 * the confusion the per-epic colour exists to prevent.
 */
export function cardEpicRole(task: ProjectTaskMeta, epicIndex: Map<string, EpicRollup>): CardEpicRole {
  const own = epicIndex.get(task.slug)
  if (own && isEpicCard(task, own.children.length)) return { kind: 'epic', rollup: own }
  if (task.epic) return { kind: 'child', epicId: task.epic, rollup: epicIndex.get(task.epic) }
  return { kind: 'none' }
}

/**
 * The id a card's colour rail derives from, or null for no rail.
 *
 * An epic is coloured by ITSELF and a child by its PARENT, which is what makes
 * an epic and its children share one hue down a LANES column.
 */
export function epicHueSource(role: CardEpicRole, task: ProjectTaskMeta): string | null {
  if (role.kind === 'epic') return task.slug
  if (role.kind === 'child') return role.epicId
  return null
}
