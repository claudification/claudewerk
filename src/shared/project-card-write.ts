/**
 * Mutating the board, keyed by ID ALONE.
 *
 * Two rules make everything else fall out:
 *   1. NOTHING EVER MOVES. A lane change rewrites one frontmatter key. The id
 *      is fixed at create and immutable for the card's whole life.
 *   2. NOTHING IS EVER WRITTEN INTO A LANE DIRECTORY AGAIN. A write that lands
 *      on a legacy-resident card relocates it into `cards/` first, so a board
 *      drains itself card by card even if the upgrade script never runs.
 */

import { existsSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { makeBodyPreview } from './body-preview'
import { asStatus, readRawCard, serializeCard } from './project-card-file'
import { getProjectTask, locateCard, readFileOrNull } from './project-card-read'
import { findLegacyCard, relocateLegacyCard } from './project-legacy'
import { cardPath } from './project-paths'
import { foldAliases, type ProjectTaskInput } from './project-task-input'
import type { ProjectTask, ProjectTaskMeta } from './project-task-types'
import type { TaskStatus } from './task-statuses'
import { WALL_PINNED_KEY } from './wall-pin'

/**
 * Resolve a card for WRITING, relocating it out of a legacy lane on the way.
 * `laneStatus` is the lane it came from -- the only record of its status, so
 * the caller must pin it into frontmatter as part of the write.
 */
function locateForWrite(root: string, id: string): { abs: string; laneStatus?: TaskStatus } | null {
  const found = locateCard(root, id)
  if (!found) return null
  if (!found.legacy) return { abs: found.abs }
  const moved = relocateLegacyCard(root, found.legacy)
  return { abs: moved ? cardPath(root, id) : found.abs, laneStatus: found.legacy.status }
}

function slugify(text: string, nowMs: number): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `task-${nowMs}`
  )
}

/** Dedup ONCE, at create -- against canonical cards and undrained lanes alike.
 *  After this the id is frozen: no later operation may change it. */
function dedupId(root: string, base: string, nowMs: number): string {
  const taken = (id: string) => existsSync(cardPath(root, id, false)) || findLegacyCard(root, id) !== null
  if (!taken(base)) return base
  for (let i = 2; i < 100; i++) {
    if (!taken(`${base}-${i}`)) return `${base}-${i}`
  }
  return `${base}-${nowMs}`
}

export function createProjectTask(root: string, raw: ProjectTaskInput, nowMs: number): ProjectTaskMeta {
  const input = foldAliases(raw) as ProjectTaskInput
  const id = dedupId(root, input.title ? slugify(input.title, nowMs) : `task-${nowMs}`, nowMs)
  const status = input.status ?? 'inbox'
  const created = new Date(nowMs).toISOString()
  const meta = {
    title: input.title,
    status,
    priority: input.priority,
    tags: input.tags?.length ? input.tags : undefined,
    refs: input.refs?.length ? input.refs : undefined,
    quest: input.quest,
    epic: input.epic,
    depends_on: input.dependsOn?.length ? input.dependsOn : undefined,
    relates_to: input.relatesTo?.length ? input.relatesTo : undefined,
    created,
    [WALL_PINNED_KEY]: input.wallPinned ? true : undefined,
  }
  writeFileSync(cardPath(root, id), serializeCard(meta, input.body), 'utf8')
  return {
    slug: id,
    status,
    title: input.title || id,
    priority: input.priority,
    tags: input.tags || [],
    refs: input.refs || [],
    quest: input.quest,
    epic: input.epic,
    dependsOn: input.dependsOn,
    relatesTo: input.relatesTo,
    wallPinned: input.wallPinned || undefined,
    created,
    mtime: nowMs,
    bodyPreview: makeBodyPreview(input.body),
  }
}

/**
 * Patch a card. Unpatched keys survive untouched -- INCLUDING every key this
 * store knows nothing about (the gate's machine-authored `evidence_*`, plus
 * `gate:`, `test_cmd:`, `base:`). The old store rebuilt cards from a fixed key
 * list and silently destroyed all of that on every update.
 */
export function updateProjectTask(root: string, id: string, rawPatch: Partial<ProjectTaskInput>): ProjectTask | null {
  const target = locateForWrite(root, id)
  if (!target) return null
  const raw = readRawCard(target.abs, readFileOrNull(target.abs))
  if (!raw) return null

  const patch = foldAliases(rawPatch)
  const meta = { ...raw.meta }
  if (patch.title !== undefined) meta.title = patch.title
  if (patch.priority !== undefined) meta.priority = patch.priority
  if (patch.tags !== undefined) meta.tags = patch.tags
  if (patch.refs !== undefined) meta.refs = patch.refs
  if (patch.quest !== undefined) meta.quest = patch.quest
  if (patch.epic !== undefined) meta.epic = patch.epic
  if (patch.dependsOn !== undefined) meta.depends_on = patch.dependsOn
  if (patch.relatesTo !== undefined) meta.relates_to = patch.relatesTo
  // UNPIN DELETES THE KEY. `serializeCard` only skips `undefined` for keys it
  // owns the order of; `wall_pinned` is not one, so leaving it set to `false`
  // here would write `wall_pinned: false` and make an unpinned card look
  // different from a card that was never pinned. See wall-pin.ts.
  if (patch.wallPinned === true) meta[WALL_PINNED_KEY] = true
  else if (patch.wallPinned === false) delete meta[WALL_PINNED_KEY]
  if (patch.status !== undefined) meta.status = patch.status
  // A legacy card's lane directory was its only status record -- pin it before
  // the file leaves that directory behind.
  const status = asStatus(meta.status) ?? target.laneStatus ?? 'inbox'
  meta.status = status

  writeFileSync(target.abs, serializeCard(meta, patch.body ?? raw.body), 'utf8')
  return getProjectTask(root, id)
}

/**
 * Change a card's lane. Rewrites ONE frontmatter key: the file does not move
 * and the id does not change. Returns the PREVIOUS status, or null if there is
 * no such card. mtime is bumped so the card sorts to the top of its new column.
 */
export function setProjectTaskStatus(root: string, id: string, toStatus: TaskStatus, nowMs: number): TaskStatus | null {
  const target = locateForWrite(root, id)
  if (!target) return null
  const raw = readRawCard(target.abs, readFileOrNull(target.abs))
  if (!raw) return null

  const prev = asStatus(raw.meta.status) ?? target.laneStatus ?? 'inbox'
  writeFileSync(target.abs, serializeCard({ ...raw.meta, status: toStatus }, raw.body), 'utf8')
  const now = new Date(nowMs)
  try {
    utimesSync(target.abs, now, now)
  } catch {
    /* mtime is a sort hint, not correctness */
  }
  return prev
}

export function deleteProjectTask(root: string, id: string): boolean {
  const found = locateCard(root, id)
  if (!found) return false
  try {
    unlinkSync(found.abs)
  } catch {
    return false
  }
  return true
}

/**
 * @deprecated Lanes are frontmatter now -- call `setProjectTaskStatus(root, id, to, now)`.
 * Kept one release for callers still passing the old `(slug, from, to)` triple.
 * `fromStatus` is ignored, and the returned id is ALWAYS the one passed in:
 * a status change can no longer rename a card.
 */
export function moveProjectTask(
  root: string,
  id: string,
  _fromStatus: TaskStatus,
  toStatus: TaskStatus,
  nowMs: number,
): string | null {
  return setProjectTaskStatus(root, id, toStatus, nowMs) === null ? null : id
}
