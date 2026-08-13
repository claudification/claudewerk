/**
 * Project Store -- path-jailed, project-scoped filesystem access.
 *
 * Owns everything under a project root:
 *   - safe raw read/write/move of project-relative files (for the markdown viewer)
 *   - the project board card store, re-exported from its own modules:
 *       project-paths.ts       layout covenant + the path jail
 *       project-card-file.ts   one card: parse / project / serialize
 *       project-card-read.ts   queries, keyed by id
 *       project-card-write.ts  mutations, keyed by id
 *       project-legacy.ts      draining the old `<status>/` lane dirs
 *
 * There is no `views/` symlink farm any more -- one directory, no mirrors.
 * See project-paths.ts for why it was deleted.
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

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalizeCardPath, resolveInRoot } from './project-paths'

export {
  getProjectTask,
  getProjectTasksBatch,
  listProjectManifest,
  listProjectTasks,
  locateCard,
} from './project-card-read'
export {
  createProjectTask,
  deleteProjectTask,
  moveProjectTask,
  setProjectTaskStatus,
  updateProjectTask,
} from './project-card-write'
export { hasLegacyCards, listLegacyCollisions } from './project-legacy'
export {
  CARDS_DIR,
  canonicalizeCardPath,
  cardPath,
  cardRelPath,
  ProjectPathError,
  resolveInRoot,
} from './project-paths'

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

/**
 * A board path that no longer resolves gets one retry against the canonical
 * card location, so a stale `.rclaude/project/open/x.md` still opens after the
 * card's lane changed (or after the board was migrated out of lane dirs).
 */
function withCardFallback(root: string, relPath: string, abs: string): string {
  if (existsSync(abs)) return abs
  const canonical = canonicalizeCardPath(relPath)
  if (!canonical) return abs
  try {
    return resolveInRoot(root, canonical.relPath)
  } catch {
    return abs
  }
}

/** Read a project-relative file as UTF-8, jailed under root, with a byte cap. */
export function readProjectFile(root: string, relPath: string, maxBytes = DEFAULT_MAX_BYTES): ReadFileResult {
  let abs: string
  try {
    abs = withCardFallback(root, relPath, resolveInRoot(root, relPath))
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
