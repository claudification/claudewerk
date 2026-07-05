/**
 * Project Store - path-jailed, project-scoped filesystem access.
 *
 * Owns everything under a project root:
 *   - the project board task store (`.rclaude/project/{status}/{slug}.md`)
 *   - safe raw read/write/move of project-relative files (for the markdown viewer)
 *
 * Every function takes the project root (an absolute host path -- the same path
 * the project URI's path segment resolves to) and a project-RELATIVE target.
 * All raw file ops are jailed: the resolved target must stay within the root,
 * traversal (`../`), null bytes and absolute escapes are rejected.
 *
 * This module is pure filesystem + string work. It runs wherever the project's
 * files live -- today the SENTINEL (so the board works with no live agent host).
 * It has no wire, no broker, no conversation concepts.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseFrontmatter } from './frontmatter'
import type { ProjectTask, ProjectTaskManifestEntry, ProjectTaskMeta, ProjectTaskRef } from './project-task-types'
import { TASK_STATUSES, type TaskStatus } from './task-statuses'

const STATUSES = TASK_STATUSES

// ---------------------------------------------------------------------------
// Path jail
// ---------------------------------------------------------------------------

export class ProjectPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectPathError'
  }
}

/**
 * Resolve a project-relative path to an absolute path, guaranteeing it stays
 * within `root`. Rejects null bytes, absolute inputs that escape, and `../`
 * traversal. Symlinks are resolved (realpath) for any path component that
 * already exists so a symlink can't smuggle the target outside the root --
 * the deepest existing ancestor is realpath'd and re-checked.
 *
 * Returns the absolute resolved path. Throws ProjectPathError on violation.
 */
export function resolveInRoot(root: string, relPath: string): string {
  if (!root) throw new ProjectPathError('empty project root')
  if (!relPath || relPath.includes('\0')) throw new ProjectPathError('invalid path')

  const resolvedRoot = resolve(root)
  // Treat the input as project-relative even if it has a leading slash.
  const cleaned = relPath.replace(/^\/+/, '')
  const target = resolve(resolvedRoot, cleaned)

  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}/`)) {
    throw new ProjectPathError(`path escapes project root: ${relPath}`)
  }

  // Symlink check: realpath the deepest existing ancestor and re-verify.
  let probe = target
  while (probe !== resolvedRoot && !existsSync(probe)) probe = dirname(probe)
  try {
    const realProbe = realpathSync(probe)
    const realRoot = realpathSync(resolvedRoot)
    if (realProbe !== realRoot && !realProbe.startsWith(`${realRoot}/`)) {
      throw new ProjectPathError(`path escapes project root via symlink: ${relPath}`)
    }
  } catch (err) {
    if (err instanceof ProjectPathError) throw err
    // realpath failed (e.g. root itself missing) -- fall through to string guard.
  }

  return target
}

// ---------------------------------------------------------------------------
// Raw project-relative file I/O (markdown viewer + general safe access)
// ---------------------------------------------------------------------------

export interface ReadFileResult {
  ok: boolean
  /** UTF-8 file contents (present when ok). */
  content?: string
  /** Byte length on disk before any truncation. */
  size?: number
  /** True when content was clipped to the byte cap. */
  truncated?: boolean
  error?: string
}

const DEFAULT_MAX_BYTES = 1_000_000 // 1 MB read cap for the viewer

/** Read a project-relative file as UTF-8, jailed under root, with a byte cap. */
export function readProjectFile(root: string, relPath: string, maxBytes = DEFAULT_MAX_BYTES): ReadFileResult {
  let abs: string
  try {
    abs = resolveInRoot(root, relPath)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  try {
    const stat = statSync(abs)
    if (!stat.isFile()) return { ok: false, error: 'not a file' }
    const size = stat.size
    const buf = readFileSync(abs)
    const truncated = buf.byteLength > maxBytes
    const content = (truncated ? buf.subarray(0, maxBytes) : buf).toString('utf8')
    return { ok: true, content, size, truncated }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export interface WriteFileResult {
  ok: boolean
  size?: number
  error?: string
}

/** Write (create or overwrite) a project-relative file, jailed under root. */
export function writeProjectFile(root: string, relPath: string, content: string): WriteFileResult {
  let abs: string
  try {
    abs = resolveInRoot(root, relPath)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  try {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
    return { ok: true, size: Buffer.byteLength(content) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export interface MoveFileResult {
  ok: boolean
  error?: string
}

/** Move/rename a project-relative file, both ends jailed under root. */
export function moveProjectFile(root: string, fromRel: string, toRel: string): MoveFileResult {
  let fromAbs: string
  let toAbs: string
  try {
    fromAbs = resolveInRoot(root, fromRel)
    toAbs = resolveInRoot(root, toRel)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  try {
    if (!existsSync(fromAbs)) return { ok: false, error: 'source does not exist' }
    mkdirSync(dirname(toAbs), { recursive: true })
    renameSync(fromAbs, toAbs)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Project board task store (.rclaude/project/{status}/{slug}.md)
// ---------------------------------------------------------------------------

export interface ProjectTaskInput {
  title?: string
  body: string
  priority?: 'low' | 'medium' | 'high'
  tags?: string[]
  refs?: string[]
  /** Quest membership (plan-quest-engine §4a). Written as a `quest:` frontmatter
   *  key; preserved across lane moves. */
  quest?: string
}

function boardRoot(root: string): string {
  return join(root, '.rclaude', 'project')
}

function statusDir(root: string, status: TaskStatus): string {
  const d = join(boardRoot(root), status)
  mkdirSync(d, { recursive: true })
  return d
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

function dedupSlug(dir: string, base: string, nowMs: number): string {
  if (!existsSync(join(dir, `${base}.md`))) return base
  for (let i = 2; i < 100; i++) {
    if (!existsSync(join(dir, `${base}-${i}.md`))) return `${base}-${i}`
  }
  return `${base}-${nowMs}`
}

function toMarkdown(input: ProjectTaskInput, createdIso: string): string {
  const lines = ['---']
  if (input.title) lines.push(`title: ${input.title}`)
  if (input.priority) lines.push(`priority: ${input.priority}`)
  if (input.tags?.length) lines.push(`tags: [${input.tags.join(', ')}]`)
  if (input.refs?.length) lines.push(`refs: [${input.refs.join(', ')}]`)
  if (input.quest) lines.push(`quest: ${input.quest}`)
  lines.push(`created: ${createdIso}`)
  lines.push('---')
  lines.push('')
  lines.push(input.body)
  return lines.join('\n')
}

function readTask(dir: string, filename: string, status: TaskStatus): ProjectTask | null {
  try {
    const filepath = join(dir, filename)
    const content = readFileSync(filepath, 'utf8')
    const { meta, body } = parseFrontmatter(content)
    const slug = filename.replace(/\.md$/, '')
    const mtime = statSync(filepath).mtimeMs
    return {
      slug,
      status,
      title: String(meta.title || slug),
      priority: ['low', 'medium', 'high'].includes(String(meta.priority))
        ? (String(meta.priority) as 'low' | 'medium' | 'high')
        : undefined,
      tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
      refs: Array.isArray(meta.refs) ? meta.refs.map(String) : [],
      quest: meta.quest ? String(meta.quest) : undefined,
      created: String(meta.created || ''),
      mtime,
      body,
      bodyPreview: body.split('\n').filter(Boolean).join(' ').slice(0, 600),
    }
  } catch {
    return null
  }
}

export function listProjectTasks(root: string, filterStatus?: TaskStatus): ProjectTaskMeta[] {
  const statuses = filterStatus ? [filterStatus] : STATUSES
  const tasks: ProjectTaskMeta[] = []
  for (const s of statuses) {
    const dir = statusDir(root, s)
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.md')) continue
        const task = readTask(dir, file, s)
        if (task) {
          const { body: _, ...meta } = task
          tasks.push(meta)
        }
      }
    } catch {
      /* empty */
    }
  }
  return tasks.sort((a, b) => b.mtime - a.mtime)
}

/**
 * Cheap manifest -- identity + mtime only, no frontmatter parse. Sorted mtime DESC.
 */
export function listProjectManifest(root: string): ProjectTaskManifestEntry[] {
  const entries: ProjectTaskManifestEntry[] = []
  for (const s of STATUSES) {
    const dir = statusDir(root, s)
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.md')) continue
        try {
          const mtime = statSync(join(dir, file)).mtimeMs
          entries.push({ slug: file.replace(/\.md$/, ''), status: s, mtime })
        } catch {
          /* file vanished between readdir and stat */
        }
      }
    } catch {
      /* status dir absent or unreadable */
    }
  }
  return entries.sort((a, b) => b.mtime - a.mtime)
}

/** Hydrate a batch of tasks by (slug, status). Missing refs silently skipped. */
export function getProjectTasksBatch(root: string, refs: ProjectTaskRef[]): ProjectTaskMeta[] {
  const out: ProjectTaskMeta[] = []
  for (const ref of refs) {
    const dir = statusDir(root, ref.status)
    const task = readTask(dir, `${ref.slug}.md`, ref.status)
    if (task) {
      const { body: _, ...meta } = task
      out.push(meta)
    }
  }
  return out
}

export function getProjectTask(root: string, status: TaskStatus, slug: string): ProjectTask | null {
  const dir = statusDir(root, status)
  return readTask(dir, `${slug}.md`, status)
}

export function createProjectTask(root: string, input: ProjectTaskInput, nowMs: number): ProjectTaskMeta {
  const dir = statusDir(root, 'inbox')
  const baseSlug = input.title ? slugify(input.title, nowMs) : `task-${nowMs}`
  const slug = dedupSlug(dir, baseSlug, nowMs)
  const createdIso = new Date(nowMs).toISOString()
  const content = toMarkdown(input, createdIso)
  writeFileSync(join(dir, `${slug}.md`), content, 'utf8')
  return {
    slug,
    status: 'inbox',
    title: input.title || slug,
    priority: input.priority,
    tags: input.tags || [],
    refs: input.refs || [],
    quest: input.quest,
    created: createdIso,
    mtime: nowMs,
    bodyPreview: input.body.split('\n').filter(Boolean).join(' ').slice(0, 600),
  }
}

export function updateProjectTask(
  root: string,
  status: TaskStatus,
  slug: string,
  patch: Partial<ProjectTaskInput>,
): ProjectTask | null {
  const task = getProjectTask(root, status, slug)
  if (!task) return null
  const updated: ProjectTaskInput = {
    title: patch.title ?? task.title,
    body: patch.body ?? task.body,
    priority: patch.priority ?? task.priority,
    tags: patch.tags ?? task.tags,
    refs: patch.refs ?? task.refs,
    quest: patch.quest ?? task.quest,
  }
  const content = toMarkdown(updated, task.created || new Date().toISOString())
  writeFileSync(join(statusDir(root, status), `${slug}.md`), content, 'utf8')
  return getProjectTask(root, status, slug)
}

/** Move a task between status folders. Returns the (possibly deduped) slug, or null. */
export function moveProjectTask(
  root: string,
  slug: string,
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
  nowMs: number,
): string | null {
  const fromDir = statusDir(root, fromStatus)
  const toDir = statusDir(root, toStatus)
  const fromPath = join(fromDir, `${slug}.md`)
  if (!existsSync(fromPath)) return null
  const newSlug = dedupSlug(toDir, slug, nowMs)
  const destPath = join(toDir, `${newSlug}.md`)
  renameSync(fromPath, destPath)
  // Touch mtime so the moved task sorts to top of its new column.
  const now = new Date(nowMs)
  utimesSync(destPath, now, now)
  return newSlug
}

export function deleteProjectTask(root: string, status: TaskStatus, slug: string): boolean {
  const filepath = join(statusDir(root, status), `${slug}.md`)
  if (!existsSync(filepath)) return false
  unlinkSync(filepath)
  return true
}
