/**
 * One card on disk: parse, project to the wire shape, serialize back.
 *
 * PRESERVE-UNKNOWN-KEYS is the load-bearing rule here. A card's frontmatter is
 * not a closed schema -- the DONE-gate machine-authors `evidence_branch`,
 * `evidence_base`, `evidence_commits`, `evidence_diffstat`, `evidence_tests`,
 * `evidence_worker`; cards carry `gate:`, `test_cmd:`, `base:`. The old store
 * rebuilt every card from a fixed key list, so any update silently destroyed
 * all of it (a Guard bounce wiped the evidence it had just been checked
 * against). Every write here round-trips the full bag and overlays only what
 * the caller actually patched.
 */

import { statSync } from 'node:fs'
import { parseFrontmatter, serializeFrontmatter } from './frontmatter'
import type { ProjectTask } from './project-task-types'
import { TASK_STATUSES, type TaskStatus } from './task-statuses'

/** Keys the store owns and renders in a stable order. Everything else is
 *  preserved verbatim, after these. */
const ORDERED_KEYS = ['title', 'status', 'priority', 'tags', 'refs', 'quest', 'epic', 'depends_on', 'created'] as const

const PRIORITIES = ['low', 'medium', 'high'] as const
type Priority = (typeof PRIORITIES)[number]

function asPriority(v: unknown): Priority | undefined {
  return (PRIORITIES as readonly string[]).includes(String(v)) ? (String(v) as Priority) : undefined
}

export function asStatus(v: unknown): TaskStatus | undefined {
  return (TASK_STATUSES as readonly string[]).includes(String(v)) ? (String(v) as TaskStatus) : undefined
}

export interface RawCard {
  meta: Record<string, unknown>
  body: string
  mtime: number
}

/** Parse a card file. Returns null if it can't be read. */
export function readRawCard(abs: string, content: string | null): RawCard | null {
  if (content === null) return null
  const { meta, body } = parseFrontmatter(content)
  let mtime = 0
  try {
    mtime = statSync(abs).mtimeMs
  } catch {
    /* caller already has the content; a missing stat just means mtime 0 */
  }
  return { meta, body, mtime }
}

/**
 * Project a parsed card to the wire shape. `fallbackStatus` covers a legacy
 * card whose lane directory is the only place its status is recorded; a
 * `status:` key always wins.
 */
export function toProjectTask(raw: RawCard, id: string, fallbackStatus?: TaskStatus): ProjectTask {
  const body = raw.body
  return {
    slug: id,
    status: asStatus(raw.meta.status) ?? fallbackStatus ?? 'inbox',
    title: String(raw.meta.title || id),
    priority: asPriority(raw.meta.priority),
    tags: Array.isArray(raw.meta.tags) ? raw.meta.tags.map(String) : [],
    refs: Array.isArray(raw.meta.refs) ? raw.meta.refs.map(String) : [],
    quest: raw.meta.quest ? String(raw.meta.quest) : undefined,
    epic: raw.meta.epic ? String(raw.meta.epic) : undefined,
    // `depends_on` keeps its snake_case name on disk (that is what the cards
    // already carry); the wire shape is camelCase like every other field.
    dependsOn: Array.isArray(raw.meta.depends_on) ? raw.meta.depends_on.map(String) : undefined,
    created: String(raw.meta.created || ''),
    mtime: raw.mtime,
    body,
    bodyPreview: body.split('\n').filter(Boolean).join(' ').slice(0, 600),
  }
}

/**
 * Serialize a card, store-owned keys first (stable order) then every other key
 * the file already carried, untouched.
 */
export function serializeCard(meta: Record<string, unknown>, body: string): string {
  const ordered: Record<string, unknown> = {}
  for (const key of ORDERED_KEYS) {
    if (meta[key] !== undefined && meta[key] !== null && meta[key] !== '') ordered[key] = meta[key]
  }
  for (const [key, val] of Object.entries(meta)) {
    if (!(ORDERED_KEYS as readonly string[]).includes(key)) ordered[key] = val
  }
  return serializeFrontmatter(ordered, body)
}
