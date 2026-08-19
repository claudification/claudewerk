/**
 * WHAT A CALLER MAY SAY when creating or patching a card -- the write-side
 * contract, apart from the writing.
 *
 * It sits in its own file because it is the seam where the LINKAGE REGISTRY
 * meets the API: `blockedBy` is not a field the store keeps, it is a spelling
 * the store accepts, and `foldAliases` is where that stops being true. Past this
 * point there is exactly one `dependsOn` and nothing downstream -- create,
 * update, serialize, the rollup -- has to know a second spelling ever existed.
 */

import type { TaskStatus } from './task-statuses'

export interface ProjectTaskInput {
  title?: string
  body: string
  priority?: 'low' | 'medium' | 'high'
  tags?: string[]
  refs?: string[]
  /** Lane. A frontmatter key, not a folder. Defaults to `inbox` on create. */
  status?: TaskStatus
  /** Quest membership (plan-quest-engine §4a) -- survives every lane change. */
  quest?: string
  /** Epic membership: the parent epic's card id. Same shape as `quest` --
   *  declared here on the child, never as a list on the parent. */
  epic?: string
  /** Sibling ids this card waits on. Serialized as `depends_on` (snake_case is
   *  what the existing cards carry). Sequencing only, never parenthood. */
  dependsOn?: string[]
  /** The same relation said the other way round. Merged into `dependsOn` before
   *  anything is written, so disk carries one spelling -- a second stored key
   *  would mean every reader on the board had to join two forever. */
  blockedBy?: string[]
  /** Cards worth reading alongside this one. Serialized as `relates_to`. */
  relatesTo?: string[]
  /** Watchlist this epic onto THE WALL. `false` REMOVES the key rather than
   *  writing `wall_pinned: false` -- an unpinned card should read exactly like a
   *  card that was never pinned, so grepping the board for the key answers
   *  "what is pinned" with no false positives. */
  wallPinned?: boolean
}

/** Fold the alias input into the one field that is stored, so create and update
 *  both see a single `dependsOn` and neither has to know the alias exists. */
export function foldAliases(input: Partial<ProjectTaskInput>): Partial<ProjectTaskInput> {
  if (!input.blockedBy) return input
  const merged = [...new Set([...(input.dependsOn ?? []), ...input.blockedBy])]
  const { blockedBy: _dropped, ...rest } = input
  return { ...rest, dependsOn: merged }
}
