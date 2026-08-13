/**
 * Reading the board, keyed by ID ALONE.
 *
 * `status` is a frontmatter field, so a card's lane can change without its file
 * moving -- see project-paths.ts for the layout covenant. Reads are strictly
 * non-destructive: a card still sitting in a legacy lane directory is listed
 * from where it lies (a read-only checkout still shows its whole board); only
 * writes drain it (project-card-write.ts).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { asStatus, readRawCard, toProjectTask } from './project-card-file'
import { findLegacyCard, type LegacyCard, listLegacyCards } from './project-legacy'
import { cardPath, cardsDir } from './project-paths'
import type { ProjectTask, ProjectTaskManifestEntry, ProjectTaskMeta, ProjectTaskRef } from './project-task-types'
import type { TaskStatus } from './task-statuses'

export function readFileOrNull(abs: string): string | null {
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

function stripMeta(task: ProjectTask): ProjectTaskMeta {
  const { body: _body, ...meta } = task
  return meta
}

/** Where a card actually lives right now: canonical first, then the lanes. */
export function locateCard(root: string, id: string): { abs: string; legacy: LegacyCard | null } | null {
  const canonical = cardPath(root, id, false)
  if (existsSync(canonical)) return { abs: canonical, legacy: null }
  const legacy = findLegacyCard(root, id)
  return legacy ? { abs: legacy.abs, legacy } : null
}

export function getProjectTask(root: string, id: string): ProjectTask | null {
  const found = locateCard(root, id)
  if (!found) return null
  const raw = readRawCard(found.abs, readFileOrNull(found.abs))
  return raw ? toProjectTask(raw, id, found.legacy?.status) : null
}

interface CardRef {
  id: string
  abs: string
  laneStatus?: TaskStatus
}

/** Every card: the canonical set plus any legacy stragglers the sweep hasn't
 *  drained. A canonical card always shadows a same-id legacy one. */
function allCards(root: string): CardRef[] {
  const out: CardRef[] = []
  const seen = new Set<string>()
  let files: string[] = []
  try {
    files = readdirSync(cardsDir(root))
  } catch {
    /* board not created yet */
  }
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const id = file.slice(0, -3)
    seen.add(id)
    out.push({ id, abs: cardPath(root, id, false) })
  }
  for (const legacy of listLegacyCards(root)) {
    if (seen.has(legacy.slug)) continue
    out.push({ id: legacy.slug, abs: legacy.abs, laneStatus: legacy.status })
  }
  return out
}

export function listProjectTasks(root: string, filterStatus?: TaskStatus): ProjectTaskMeta[] {
  const tasks: ProjectTaskMeta[] = []
  for (const { id, abs, laneStatus } of allCards(root)) {
    const raw = readRawCard(abs, readFileOrNull(abs))
    if (!raw) continue
    const task = toProjectTask(raw, id, laneStatus)
    if (filterStatus && task.status !== filterStatus) continue
    tasks.push(stripMeta(task))
  }
  return tasks.sort((a, b) => b.mtime - a.mtime)
}

/**
 * Cheap manifest: identity, lane and mtime. It still opens each file -- the
 * lane lives inside it now -- but skips frontmatter parsing and the body
 * projection, which is what the watcher's diff actually costs.
 */
export function listProjectManifest(root: string): ProjectTaskManifestEntry[] {
  const entries: ProjectTaskManifestEntry[] = []
  for (const { id, abs, laneStatus } of allCards(root)) {
    const content = readFileOrNull(abs)
    if (content === null) continue
    let mtime = 0
    try {
      mtime = statSync(abs).mtimeMs
    } catch {
      continue // vanished between readdir and stat
    }
    const status = asStatus(content.match(/^status:\s*(.+)$/m)?.[1]?.trim()) ?? laneStatus ?? 'inbox'
    entries.push({ slug: id, status, mtime })
  }
  return entries.sort((a, b) => b.mtime - a.mtime)
}

/** Hydrate a batch by id. `ref.status`, if a caller still sends one, is an
 *  ignored hint -- the card's own frontmatter is the truth. */
export function getProjectTasksBatch(root: string, refs: ProjectTaskRef[]): ProjectTaskMeta[] {
  const out: ProjectTaskMeta[] = []
  for (const ref of refs) {
    const task = getProjectTask(root, ref.slug)
    if (task) out.push(stripMeta(task))
  }
  return out
}
