/**
 * One directory walker, shared by the file-sweep estimate and the sweep itself.
 *
 * Deliberately single-sourced: measuring "what would be deleted" and then
 * deleting it are the two halves of the same promise, and two walkers that
 * drifted apart would mean a dialog that reports one set of files and removes
 * another.
 */

import { type Dirent, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Guards against a pathological tree; the cache dir is nowhere near this deep. */
const MAX_DEPTH = 12

export interface WalkedFile {
  path: string
  bytes: number
  mtimeMs: number
}

/** Every regular file under `dir`, recursively.
 *
 *  Symlinks are skipped rather than followed. That is a safety property, not
 *  tidiness: following one could make a sweep delete a file outside the cache
 *  directory, or loop forever. Entries that fail to stat (raced with a writer)
 *  are skipped -- they are not ours to report on or remove. */
export function walkFiles(dir: string, visit: (file: WalkedFile) => void, depth = 0): void {
  if (depth > MAX_DEPTH) return

  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // missing or unreadable: the caller reports it as unconfigured
  }

  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      walkFiles(path, visit, depth + 1)
      continue
    }
    try {
      const st = statSync(path)
      visit({ path, bytes: st.size, mtimeMs: st.mtimeMs })
    } catch {
      // raced with a writer
    }
  }
}
