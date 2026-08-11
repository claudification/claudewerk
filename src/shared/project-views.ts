/**
 * The `views/` symlink farm -- lanes as a browsable directory tree, without
 * lanes owning identity.
 *
 * `views/<status>/<id>.md` is a RELATIVE symlink to `../../cards/<id>.md`.
 * Straight out of systemd's `*.wants/`, sysvinit's `rcN.d/`, `/dev/disk/by-*`
 * and Nix profiles: one canonical store, many generated views.
 *
 * RULES:
 *   - Nothing in this codebase ever READS the farm. It exists so `ls`, Finder
 *     and a file-tree UI can still show you columns. Deleting it is harmless.
 *   - It is therefore never a failure path: a filesystem that refuses symlinks
 *     (Windows without developer mode -> EPERM) just doesn't get views. A board
 *     op must never fail because a cosmetic link could not be written.
 *   - The sentinel's board watcher EXCLUDES this tree -- otherwise every status
 *     change fires twice (once for the card, once for its link).
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { CARDS_DIR, viewsDir } from './project-paths'
import { TASK_STATUSES, type TaskStatus } from './task-statuses'

/** Flipped the first time the filesystem refuses a symlink. Views are cosmetic;
 *  once we know they're unavailable we stop paying for the attempts. */
let symlinksUnsupported = false

/** False once the filesystem has refused a symlink (Windows without dev mode). */
export function viewsSupported(): boolean {
  return !symlinksUnsupported
}

/** Relative target from `views/<status>/` back to the canonical card. */
function linkTarget(id: string): string {
  return join('..', '..', CARDS_DIR, `${id}.md`)
}

function tryLink(root: string, status: string, id: string): void {
  if (symlinksUnsupported) return
  const dir = viewsDir(root, status, true)
  const link = join(dir, `${id}.md`)
  try {
    if (existsSync(link) || isLink(link)) unlinkSync(link)
    symlinkSync(linkTarget(id), link)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') symlinksUnsupported = true
    /* cosmetic -- never propagates */
  }
}

/** `existsSync` follows the link, so a DANGLING one reads as absent. lstat doesn't. */
function isLink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink()
  } catch {
    return false
  }
}

function dropLink(root: string, status: string, id: string): void {
  const link = join(viewsDir(root, status), `${id}.md`)
  if (!existsSync(link) && !isLink(link)) return
  try {
    unlinkSync(link)
  } catch {
    /* cosmetic */
  }
}

/**
 * Point one card's view at its current lane. O(1)-ish: drops the card's link
 * from every other lane (6 lstats, self-healing if a previous relink was
 * interrupted) and creates the one that belongs.
 */
export function relinkCard(root: string, id: string, status: TaskStatus): void {
  for (const s of TASK_STATUSES) {
    if (s !== status) dropLink(root, s, id)
  }
  tryLink(root, status, id)
}

/** Drop every view of a card (it was deleted). */
export function removeCardViews(root: string, id: string): void {
  for (const s of TASK_STATUSES) dropLink(root, s, id)
}

export interface ViewsReport {
  created: number
  pruned: number
  supported: boolean
}

/** A link is correct only if it exists, IS a symlink, and points at the card
 *  this lane's view should point at. Anything else is stale. */
function isCorrectLink(root: string, status: TaskStatus, id: string): boolean {
  const link = join(viewsDir(root, status), `${id}.md`)
  return isLink(link) && readLinkSafe(link) === linkTarget(id)
}

/** Drop links that are stale, dangling, or aiming somewhere unexpected. */
function pruneStaleLinks(root: string, wanted: Set<string>): number {
  let pruned = 0
  for (const status of TASK_STATUSES) {
    const dir = viewsDir(root, status)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue // lane view dir doesn't exist yet
    }
    for (const file of entries) {
      if (!file.endsWith('.md')) continue
      const id = file.slice(0, -3)
      if (wanted.has(`${status}/${id}`) && isCorrectLink(root, status, id)) continue
      try {
        rmSync(join(dir, file), { force: true })
        pruned++
      } catch {
        /* cosmetic */
      }
    }
  }
  return pruned
}

/**
 * Rebuild the whole farm from the card set: create what's missing, prune what
 * is stale, dangling, or points somewhere unexpected. Idempotent -- running it
 * on a correct farm changes nothing and reports zeroes.
 */
export function rebuildProjectViews(root: string, cards: { slug: string; status: TaskStatus }[]): ViewsReport {
  const wanted = new Set(cards.map(c => `${c.status}/${c.slug}`))
  const pruned = pruneStaleLinks(root, wanted)

  let created = 0
  for (const c of cards) {
    if (isCorrectLink(root, c.status, c.slug)) continue
    tryLink(root, c.status, c.slug)
    if (isCorrectLink(root, c.status, c.slug)) created++
  }

  return { created, pruned, supported: !symlinksUnsupported }
}

function readLinkSafe(abs: string): string | null {
  try {
    return readlinkSync(abs)
  } catch {
    return null
  }
}
