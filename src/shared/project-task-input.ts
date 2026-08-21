/**
 * WHAT A CALLER MAY SAY when creating or patching a card -- the write-side
 * contract, apart from the writing.
 *
 * It sits in its own file because it is the seam where the LINKAGE REGISTRY
 * meets the API: `blockedBy` is not a field the store keeps, it is a spelling
 * the store accepts, and `foldAliases` is where that stops being true. Past this
 * point there is exactly one `dependsOn` and nothing downstream -- create,
 * update, serialize, the rollup -- has to know a second spelling ever existed.
 *
 * TWO FOLDS NOW, and the second one earns its place by the same rule rather than
 * by resembling the first: `#model-<slug>` is a spelling of `model:` that a
 * touchscreen can type, and it collapses HERE so that no reader downstream ever
 * has to ask which of the two a card used.
 */

import { foldModelTags } from './card-model'
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
  /** Why an archived card was archived: `done`, `cold`, or
   *  `duplicate-of:<card-id>`. Serialized as `archived_reason`. Only meaningful
   *  with `status: 'archived'` -- project-doctor-lifecycle.ts says so out loud
   *  rather than rejecting it, because the two keys arrive in one patch and a
   *  writer that enforced the pair would make un-archiving impossible. */
  archivedReason?: string
  /** Who archived it -- a report id (`report-2026-08-22`) or another actor.
   *  Serialized as `archived_by`. Without it the archive is an unattributed
   *  mutation, which is the whole thing the on-card record exists to prevent. */
  archivedBy?: string
  /** ISO 8601 date after which the card MAY be deleted. Serialized as
   *  `delete_at`. A MARKER, never an instruction: nothing in this codebase
   *  deletes on it (epic-morning-report F18 -- removal is a human act). */
  deleteAt?: string
  /** Model hint for a seat dispatched against this card. Serialized as `model`.
   *  Also reachable as a `#model-<slug>` TAG, which `foldAliases` normalises
   *  into this field -- see below for why the tag exists at all. */
  model?: string
  /** Watchlist this epic onto THE WALL. `false` REMOVES the key rather than
   *  writing `wall_pinned: false` -- an unpinned card should read exactly like a
   *  card that was never pinned, so grepping the board for the key answers
   *  "what is pinned" with no false positives. */
  wallPinned?: boolean
}

/**
 * `#model-opus` -> `model: opus`, and the tag does not reach the board.
 *
 * TWO SPELLINGS, ONE STORED KEY -- the same bargain `blockedBy` makes, for the
 * same reason. The tag exists because it is typeable with no grammar support at
 * all: on a phone or an iPad there is no `:` completer popup to accept from, and
 * a hash-word is what the capture box was already going to keep verbatim. What
 * it must NOT do is survive as a tag, because then "which model does this card
 * ask for" has two answers and every reader has to check both.
 *
 * AN EXPLICIT `model` WINS. A caller that set the field and also typed the tag
 * said the same thing twice at different confidence; the field is the one it
 * meant. An UNRECOGNISED slug is not folded at all -- `#model-frobnicate` stays
 * an ordinary tag, because eating it would destroy the only evidence of what was
 * actually typed, which is exactly what the doctor finding needs to quote.
 */
function foldModelTag(input: Partial<ProjectTaskInput>): Partial<ProjectTaskInput> {
  if (!input.tags?.length) return input
  const folded = foldModelTags(input.tags)
  if (folded.model === undefined) return input
  return { ...input, tags: folded.tags, model: input.model ?? folded.model }
}

/** Fold the alias input into the one field that is stored, so create and update
 *  both see a single `dependsOn` and neither has to know the alias exists. */
export function foldAliases(input: Partial<ProjectTaskInput>): Partial<ProjectTaskInput> {
  const withModel = foldModelTag(input)
  if (!withModel.blockedBy) return withModel
  const merged = [...new Set([...(withModel.dependsOn ?? []), ...withModel.blockedBy])]
  const { blockedBy: _dropped, ...rest } = withModel
  return { ...rest, dependsOn: merged }
}
