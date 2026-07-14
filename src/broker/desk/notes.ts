/**
 * The USER'S permanent NOTES file -- what the dispatcher writes when the user
 * says "take my notes" / "note that ...".
 *
 * Distinct from `dispatch-memory.md` (memory.ts), which the dispatcher curates
 * ITSELF via a cheap LLM digest and keeps tiny + rolling. This file is the
 * USER's: durable, uncapped, and mutated ONLY by explicit tool calls
 * (read/append/write/edit/clear). Nothing prunes it automatically. Every
 * destructive rewrite (write/edit/clear) snapshots the prior content first
 * (file-history.ts), so a fat-fingered clear is always recoverable.
 *
 * File-backed + module-singleton (mirrors initDispatchMemory). Single file
 * today (single-user reality); the userId param is the seam for per-user
 * scoping later.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { snapshotFile } from './file-history'

let notesFile: string | null = null

/** Point the notes store at its file (mirrors initDispatchMemory). */
export function initUserNotes(cacheDir: string): void {
  notesFile = resolve(cacheDir, 'user-notes.md')
}

/** Test/explicit override of the file path. */
export function setUserNotesFile(path: string): void {
  notesFile = path
}

/** The full notes file, verbatim. Empty string when nothing is saved yet. */
export function readNotes(_userId?: string | null): string {
  if (!notesFile || !existsSync(notesFile)) return ''
  return readFileSync(notesFile, 'utf8')
}

/** Append text as a new block, newline-separated. No-op for blank input.
 *  Returns the resulting total length. */
export function appendNotes(text: string, _userId?: string | null): { appended: boolean; length: number } {
  if (!notesFile) return { appended: false, length: 0 }
  const clean = text.trim()
  if (!clean) return { appended: false, length: readNotes().length }
  mkdirSync(dirname(notesFile), { recursive: true })
  const existing = readNotes()
  // Separate blocks with a blank line, but don't lead the file with newlines.
  const prefix = existing.length > 0 && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : ''
  appendFileSync(notesFile, `${prefix}${clean}\n`, 'utf8')
  return { appended: true, length: readNotes().length }
}

/** Overwrite the whole notes file (snapshots the prior content first). */
export function writeNotes(content: string, _userId?: string | null): { length: number } {
  if (!notesFile) return { length: 0 }
  snapshotFile(notesFile)
  mkdirSync(dirname(notesFile), { recursive: true })
  const body = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`
  writeFileSync(notesFile, body, 'utf8')
  return { length: body.length }
}

export type EditNotesResult = { ok: true; replaced: number } | { ok: false; error: string }

/** Exact-string replace, mirroring Claude Code's Edit tool: `oldString` must
 *  occur EXACTLY ONCE unless `replaceAll` is set (then every occurrence goes).
 *  Snapshots before writing. Never partial-writes on a rejected edit. */
export function editNotes(
  oldString: string,
  newString: string,
  replaceAll = false,
  _userId?: string | null,
): EditNotesResult {
  if (!notesFile) return { ok: false, error: 'notes store not initialized' }
  if (oldString === newString) return { ok: false, error: 'oldString and newString are identical -- nothing to change' }
  const current = readNotes()
  if (!current) return { ok: false, error: 'notes are empty -- nothing to edit' }
  const count = current.split(oldString).length - 1
  if (count === 0) return { ok: false, error: `oldString not found in notes: ${JSON.stringify(oldString)}` }
  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      error: `oldString found ${count} times -- pass replaceAll:true or make it unique`,
    }
  }
  const next = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString)
  snapshotFile(notesFile)
  writeFileSync(notesFile, next, 'utf8')
  return { ok: true, replaced: replaceAll ? count : 1 }
}

/** Empty the notes file (snapshots the prior content first, so it's recoverable). */
export function clearNotes(_userId?: string | null): { cleared: boolean } {
  if (!notesFile || !existsSync(notesFile) || readNotes().length === 0) return { cleared: false }
  snapshotFile(notesFile)
  writeFileSync(notesFile, '', 'utf8')
  return { cleared: true }
}
