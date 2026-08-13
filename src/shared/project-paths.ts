/**
 * Where the board's files live, plus the jail that keeps every path inside the
 * project root.
 *
 * LAYOUT COVENANT -- a card lives at `.rclaude/project/cards/<id>.md` from
 * creation to deletion and NEVER moves. Its lane is a `status:` frontmatter
 * key, not a directory. Consequences worth stating out loud:
 *
 *   - `id` is the whole primary key. No `(status, slug)` tuple, ever.
 *   - a link written today resolves forever, whatever lane the card ends up in.
 *   - ONE DIRECTORY, no mirrors. There is no generated `views/` symlink farm
 *     any more (deleted 2026-08-13). A second copy of the lane structure was a
 *     second thing to keep true, and it did not stay true: nothing read it, the
 *     watcher had to exclude it to avoid double-firing, every write paid to
 *     maintain it, and it still drifted -- one live board had 43 of 301 cards
 *     with no link at all. A lane is one line inside one file. Filter the cards.
 *   - the old `<status>/<id>.md` lane dirs are read-only legacy, drained by
 *     `scripts/board-upgrade.ts` and by lazy per-card migration on write
 *     (project-legacy.ts). Nothing is ever written into them again.
 *
 * Prior art for the shape: notmuch (files never move, state is an index),
 * Maildir (the unique filename IS the identity), Jekyll/Hugo (a flat dir where
 * frontmatter is the whole taxonomy).
 */

import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CARDS_DIR } from './card-path'

// The pure path SHAPE (and the legacy-path resolver every link depends on)
// lives in card-path.ts so the browser bundle can import it too.
export { CARDS_DIR, canonicalizeCardPath, cardRelPath } from './card-path'

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
 * NOTE: an IN-root symlink resolves to an in-root target and therefore passes.
 * That is deliberate: the jail's job is keeping paths inside the root, not
 * banning symlinks a user made themselves.
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

/** `<root>/.rclaude/project`. */
export function boardRoot(root: string): string {
  return join(root, '.rclaude', 'project')
}

/** `<root>/.rclaude/project/cards`, created on demand. */
export function cardsDir(root: string, create = true): string {
  const dir = join(boardRoot(root), CARDS_DIR)
  if (create) mkdirSync(dir, { recursive: true })
  return dir
}

/** Absolute path of one card. The only place `<id>.md` is spelled out. */
export function cardPath(root: string, id: string, create = true): string {
  return join(cardsDir(root, create), `${id}.md`)
}

/** A legacy lane directory (`<root>/.rclaude/project/<status>`). READ ONLY. */
export function legacyLaneDir(root: string, status: string): string {
  return join(boardRoot(root), status)
}
