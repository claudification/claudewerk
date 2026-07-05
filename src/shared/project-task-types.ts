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
