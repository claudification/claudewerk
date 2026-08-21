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
import { readCardModel } from './card-model'
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
    archived_reason: input.archivedReason,
    archived_by: input.archivedBy,
    delete_at: input.deleteAt,
    // VALIDATED, not passed through: a free-string model on a card is a spawn
    // that fails at dispatch time, hours later, with nobody watching. An
    // unrecognised slug is dropped at the door rather than written and then
    // ignored by every reader.
    model: readCardModel(input.model),
    [WALL_PINNED_KEY]: input.wallPinned ? true : undefined,
  }
  // No blocks: a card being created has no prior bytes to preserve. A `promise:`
  // block arrives later, via promise-ledger's line surgery.
  writeFileSync(cardPath(root, id), serializeCard(meta, input.body, {}), 'utf8')
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
    archivedReason: input.archivedReason,
    archivedBy: input.archivedBy,
    deleteAt: input.deleteAt,
    // The SAME validated value that was written, never the raw input: a caller
    // that gets back a slug the file does not carry has been told a lie about
    // its own write.
    model: readCardModel(input.model),
    created,
    mtime: nowMs,
    bodyPreview: makeBodyPreview(input.body),
  }
}

/**
 * Every patch field that is a STRAIGHT overlay: present means write it, absent
 * means leave whatever the card already had. ONE entry per key (STRATEGY MAPS
 * OVER CHAINS) -- as a chain of `if`s this was the one function in the file
 * whose complexity grew every time the board learned a key, which is a poor
 * reason to think twice about adding one.
 *
 * The five fields NOT here each need a rule of their own: `body` is not
 * frontmatter, `status` falls back to a legacy lane, `wallPinned: false` DELETES
 * rather than writes, `blockedBy` is folded into `dependsOn` before this runs,
 * and `model` is VALIDATED before it is written. The `Exclude` is what keeps one
 * of them from being quietly added here and losing its rule.
 */
const OVERLAID_KEYS: readonly [
  Exclude<keyof ProjectTaskInput, 'body' | 'status' | 'wallPinned' | 'blockedBy' | 'model'>,
  string,
][] = [
  ['title', 'title'],
  ['priority', 'priority'],
  ['tags', 'tags'],
  ['refs', 'refs'],
  ['quest', 'quest'],
  ['epic', 'epic'],
  ['dependsOn', 'depends_on'],
  ['relatesTo', 'relates_to'],
  // THE LIFECYCLE KEYS. `''` is a real instruction here and not a no-op: it is
  // how an un-archive clears the record, and `serializeCard` drops an ordered
  // key holding an empty string rather than writing a bare `archived_reason:`.
  ['archivedReason', 'archived_reason'],
  ['archivedBy', 'archived_by'],
  ['deleteAt', 'delete_at'],
]

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
  for (const [field, key] of OVERLAID_KEYS) {
    const value = patch[field]
    if (value !== undefined) meta[key] = value
  }
  // UNPIN DELETES THE KEY. `serializeCard` only skips `undefined` for keys it
  // owns the order of; `wall_pinned` is not one, so leaving it set to `false`
  // here would write `wall_pinned: false` and make an unpinned card look
  // different from a card that was never pinned. See wall-pin.ts.
  if (patch.wallPinned === true) meta[WALL_PINNED_KEY] = true
  else if (patch.wallPinned === false) delete meta[WALL_PINNED_KEY]
  // AN UNUSABLE MODEL CLEARS THE KEY rather than leaving the old one standing.
  // `''` is a real instruction on an ordered key (`serializeCard` drops it), and
  // it is the honest outcome: a caller that just asked for `gpt-9` did not ask
  // for whatever the card said before, so answering "which model does this card
  // want" with the stale value would be answering a question nobody asked.
  if (patch.model !== undefined) meta.model = readCardModel(patch.model) ?? ''
  if (patch.status !== undefined) meta.status = patch.status
  // A legacy card's lane directory was its only status record -- pin it before
  // the file leaves that directory behind.
  const status = asStatus(meta.status) ?? target.laneStatus ?? 'inbox'
  meta.status = status

  writeFileSync(target.abs, serializeCard(meta, patch.body ?? raw.body, raw.raw), 'utf8')
  return getProjectTask(root, id)
}

/**
 * Change a card's lane. Rewrites ONE frontmatter key: the file does not move
 * and the id does not change. Returns the PREVIOUS status, or null if there is
 * no such card. mtime is bumped so the card sorts to the top of its new column.
 *
 * "Rewrites ONE key" was an aspiration until the nested-block capture landed:
 * this is the write path `project_set_status` uses, so before it threaded
 * `raw.raw` every lane change de-indented a card's `promise:` block and emptied
 * its `closes:`. A promise that HAD been delivered came back reading `not
 * started` -- a confident wrong answer, which is worse than no ledger at all.
 */
export function setProjectTaskStatus(root: string, id: string, toStatus: TaskStatus, nowMs: number): TaskStatus | null {
  const target = locateForWrite(root, id)
  if (!target) return null
  const raw = readRawCard(target.abs, readFileOrNull(target.abs))
  if (!raw) return null

  const prev = asStatus(raw.meta.status) ?? target.laneStatus ?? 'inbox'
  writeFileSync(target.abs, serializeCard({ ...raw.meta, status: toStatus }, raw.body, raw.raw), 'utf8')
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
