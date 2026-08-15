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
  /** Cards worth reading alongside this one. Symmetric and untyped: it asserts
   *  no order and no parenthood, which is exactly why it is a separate verb
   *  from `dependsOn` rather than a weaker flavour of it. Stored as
   *  `relates_to:`, also spelled `see_also:`. */
  relatesTo?: string[]
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
