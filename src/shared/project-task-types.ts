/**
 * Wire-shared types for project tasks. Defined once here so the agent host
 * (`src/claude-agent-host/project-tasks.ts`) and the control panel
 * (`web/src/hooks/use-project-tasks.ts`) speak the same shape.
 *
 * Storage shape is owned by the agent host: markdown files under
 * `{cwd}/.rclaude/project/{status}/{slug}.md`. The interfaces here are the
 * over-the-wire projection.
 */

import type { TaskStatus } from './task-statuses'

export interface ProjectTaskMeta {
  slug: string
  status: TaskStatus
  title: string
  priority?: 'low' | 'medium' | 'high'
  tags: string[]
  refs: string[]
  /** First-class quest membership (plan-quest-engine §4a): `quest: <petname>`.
   *  Orthogonal to `status` (the card's lane) -- a quest card keeps this key as
   *  it moves between lanes. Absent = not part of any quest. */
  quest?: string
  /** Epic membership: the id of the epic card this one belongs to. Declared by
   *  the CHILD (like `quest`) so no parent-side list can drift. See
   *  `epic-cards.ts` for the rollup this feeds. */
  epic?: string
  /** Colour OVERRIDE for an epic card: a name (`teal`) or a hue (`178`). Absent
   *  is the normal case -- `epic-color.ts` derives a stable hue from the id, so
   *  an epic is never colourless and this key only ever means "not that one".
   *  Meaningless on a non-epic card; a child paints in its parent's hue. */
  color?: string
  /** Sibling ids that must reach `done` before this card is ready. SEQUENCING
   *  only -- never parenthood, which is what the old `blocks:` key conflated.
   *  Stored as `depends_on:`; `blocked_by:` is an accepted spelling that folds
   *  into this one on read and on write (see card-linkage.ts). */
  dependsOn?: string[]
  /** Watchlisted onto THE WALL's A8 pane. Only meaningful on an epic card; a
   *  scalar boolean so it can never hit the wrapped-list frontmatter bug. Absent
   *  is the normal case -- see `wall-pin.ts` for why the pin lives on the card
   *  rather than in panel preferences. */
  wallPinned?: boolean
  /** Cards worth reading alongside this one. Symmetric and untyped: it asserts
   *  no order and no parenthood, which is exactly why it is a separate verb
   *  from `dependsOn` rather than a weaker flavour of it. Stored as
   *  `relates_to:`, also spelled `see_also:`. */
  relatesTo?: string[]
  /** Ids this card used to have. NOT linkage -- every value names a card that by
   *  definition no longer exists, so the resolver would report each one missing
   *  forever. It exists so a key frozen at spawn time (an epic seat's `cardId`,
   *  a baton acknowledgement) still resolves to the card after a rename. See
   *  `epic-card-rename.ts`. Stored as `renamed_from:`. */
  renamedFrom?: string[]
  /** Why this card was archived: `done`, `cold`, or `duplicate-of:<card-id>`.
   *  The FIRST of the three record tiers (epic-morning-report D7) and the only
   *  one that is not purgeable -- the report markdown and the audit DB both go
   *  away, so "what happened to this card" has to be answerable from the card.
   *  Stored as `archived_reason:`. */
  archivedReason?: string
  /** The actor that archived it, e.g. `report-2026-08-22`. Stored as
   *  `archived_by:`; absent alongside a reason is an unattributed mutation. */
  archivedBy?: string
  /** ISO 8601 date after which the card MAY be deleted. A MARKER a human acts
   *  on: nothing deletes on it (F18). Stored as `delete_at:`. */
  deleteAt?: string
  /** Model HINT for a seat dispatched against this card -- a refiner's judgement
   *  about how hard the work is, or a slug typed at capture time. Always a slug
   *  the spawn layer accepts: an unrecognised value reads as absent (see
   *  `card-model.ts`, which also owns the clamp that stops a card buying a tier
   *  its seat's order refused it). Stored as `model:`. */
  model?: string
  created: string
  /** File mtime in ms since epoch -- sort key, also the cache-staleness marker. */
  mtime: number
  bodyPreview: string
}

export interface ProjectTask extends ProjectTaskMeta {
  body: string
}

/** Cheap manifest entry: identity + mtime only. */
export interface ProjectTaskManifestEntry {
  slug: string
  status: TaskStatus
  mtime: number
}

/** Reference to a single task by (slug, status). Used by batched lookups. */
export interface ProjectTaskRef {
  slug: string
  status: TaskStatus
}
