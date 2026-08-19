/**
 * P3's model layer: a card move on the wire -> a ledger row on the wall.
 *
 * Pure on purpose, same as `commit-river.ts`: the two things this pane can get
 * quietly wrong are the ORDER and the AGE, and both are only testable if they
 * are functions of `(moves, nowMs)` rather than something a component reads off
 * `Date.now()` behind a render.
 *
 * EPICS ARE NOT FILTERED HERE, and nothing here should start filtering them.
 * The sentinel that observes the move drops epic cards at the source (see
 * `CardMove` in `protocol.ts`), so `epic` on a row is the id of the epic this
 * card BELONGS to, never a flag saying the row is one. A second exclusion in the
 * UI would be a rule that can rot out of sync with the one that matters.
 */

import type { CardMove, ProjectTaskStatus } from '@shared/protocol'
// Type-only, and deliberately the CANONICAL project-look shape rather than a
// third structural copy of it. No runtime edge from lib -> components is created
// by a type import, and one more hand-rolled `{ projectName, projectIcon,
// projectColor }` interface is how the wall ends up with four of them.
import type { ProjectLook } from '@/components/wall/use-project-look'
import { formatDurationShort } from '@/lib/status-style'

/** The lane whose arrival is the one everybody is actually watching for.
 *  Private: consumers read `row.isDone`, which is the answer rather than the
 *  ingredient, so nothing outside this file needs the lane name. */
const DONE_LANE: ProjectTaskStatus = 'done'

export interface LedgerRow extends ProjectLook {
  /** React key + row identity. A card can cross lanes many times, so the id
   *  alone is not unique -- the timestamp is what separates the crossings. */
  key: string
  /** Card id (the filename stem) -- what `openProjectCard` takes. */
  id: string
  /** Canonical project URI -- what the card editor needs to open the right board. */
  project: string
  title: string
  priority?: 'low' | 'medium' | 'high'
  from: ProjectTaskStatus
  to: ProjectTaskStatus
  /** `to === 'done'`. Drives both the DONE view and the row's emphasis. */
  isDone: boolean
  /** The epic this card belongs to, when it declares one. */
  epic?: string
  ts: number
  ageMs: number
  /** `ageMs` in the delta-t column's format. */
  age: string
}

/**
 * Rows, newest first.
 *
 * SORTED, not trusted. The broker serves its ring newest-first and the client
 * feed prepends deltas on top, which is right until one board write moves three
 * cards and the watcher hands them over in file order -- then a batch lands
 * internally out of order and a "what just moved" pane shows the wrong line at
 * the top. Sorting ~300 rows costs nothing and makes the claim true by
 * construction instead of by convention.
 *
 * Ties break on the id so the order is stable across renders: two cards moved by
 * the same board write share a millisecond more often than not.
 */
export function cardLedgerRows(
  moves: readonly CardMove[],
  look: (uri: string) => ProjectLook,
  nowMs: number,
): LedgerRow[] {
  return moves
    .map(move => {
      const ageMs = Math.max(0, nowMs - move.ts)
      return {
        key: `${move.project}::${move.id}@${move.ts}`,
        id: move.id,
        project: move.project,
        title: move.title,
        ...(move.priority ? { priority: move.priority } : {}),
        from: move.from,
        to: move.to,
        isDone: move.to === DONE_LANE,
        ...(move.epic ? { epic: move.epic } : {}),
        ts: move.ts,
        ageMs,
        age: formatDurationShort(ageMs),
        ...look(move.project),
      }
    })
    .sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id))
}
