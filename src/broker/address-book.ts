/**
 * Address Book: per-caller routing table with stable, locally-scoped IDs.
 *
 * Each caller project gets its own address book mapping short readable IDs
 * to target projects. IDs are auto-assigned from project name/label and
 * persisted across restarts. An ID is only meaningful to its owner --
 * leaked IDs are useless to other sessions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// callerProject -> { localId -> targetProject }
type BookMap = Record<string, Record<string, string>>

// Bump when the slug-generation rules change and existing books must be rebuilt.
// v2: project slugs are derived from project label/dirname, not session titles.
const CURRENT_VERSION = 2

type BookFile = { _version: number; books: BookMap }

let filePath = ''
let books: BookMap = {}
let dirty = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

export function initAddressBook(cacheDir: string): void {
  filePath = join(cacheDir, 'address-books.json')
  mkdirSync(dirname(filePath), { recursive: true })
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
      if (parsed && typeof parsed === 'object' && parsed._version === CURRENT_VERSION) {
        books = (parsed as BookFile).books || {}
      } else {
        // Legacy (unversioned) or older-version file: slugs may be poisoned by the
        // pre-v2 rule that used session titles as project slugs. Rebuilds lazily
        // on next list_sessions / send_message.
        books = {}
        dirty = true
      }
    } catch {
      books = {}
    }
  }
}

function scheduleSave(): void {
  if (saveTimer) return
  dirty = true
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (dirty && filePath) {
      const payload: BookFile = { _version: CURRENT_VERSION, books }
      writeFileSync(filePath, JSON.stringify(payload, null, 2))
      dirty = false
    }
  }, 1000) // debounce 1s
}

/** Generate a slug from a name. Lowercase, alphanumeric + hyphens. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'project'
  )
}

/** Get or assign a local ID for a target project, scoped to the caller. */
export function getOrAssign(callerProject: string, targetProject: string, targetName: string): string {
  if (!books[callerProject]) books[callerProject] = {}
  const book = books[callerProject]

  // Check if we already have an entry for this target
  for (const [id, proj] of Object.entries(book)) {
    if (proj === targetProject) return id
  }

  // Assign a new ID based on the target name
  let slug = slugify(targetName)
  if (book[slug]) {
    // Collision -- append suffix
    let i = 2
    while (book[`${slug}-${i}`]) i++
    slug = `${slug}-${i}`
  }

  book[slug] = targetProject
  scheduleSave()
  return slug
}

/** Resolve a local ID back to a target project. */
export function resolve(callerProject: string, localId: string): string | undefined {
  return books[callerProject]?.[localId]
}

/** Get all entries in a caller's address book. */
export function getBook(callerProject: string): Record<string, string> {
  return books[callerProject] || {}
}

/** Remove a specific entry from a caller's address book. */
export function removeEntry(callerProject: string, localId: string): void {
  if (books[callerProject]) {
    delete books[callerProject][localId]
    if (Object.keys(books[callerProject]).length === 0) {
      delete books[callerProject]
    }
    scheduleSave()
  }
}

/** Clean up entries pointing to projects that no longer have any sessions. */
export function pruneStale(activeProjects: Set<string>): number {
  let removed = 0
  for (const [callerProject, book] of Object.entries(books)) {
    for (const [id, targetProject] of Object.entries(book)) {
      if (!activeProjects.has(targetProject)) {
        delete book[id]
        removed++
      }
    }
    if (Object.keys(book).length === 0) delete books[callerProject]
  }
  if (removed > 0) scheduleSave()
  return removed
}
