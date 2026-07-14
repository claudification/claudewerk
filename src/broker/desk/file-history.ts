/**
 * Tiny file-versioning helper: snapshot a file into a sibling `<name>-versions/`
 * dir before a destructive rewrite, keeping only the most recent N snapshots.
 *
 * Extracted from memory.ts's private saveVersion (which the durable memory file
 * and the user-notes file both need) so the backup behaviour lives in one place.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export interface SnapshotOpts {
  /** Max snapshots to retain; oldest beyond this are pruned. Default 10. */
  maxVersions?: number
  /** Timestamp for the snapshot name (ms). Injectable so callers stay testable. */
  now?: number
}

/** Copy `file` into `<dir>/<stem>-versions/<iso>.<ext>`, pruning old snapshots.
 *  No-op when the file does not exist yet (nothing to back up). */
export function snapshotFile(file: string, opts: SnapshotOpts = {}): void {
  if (!existsSync(file)) return
  const maxVersions = opts.maxVersions ?? 10
  const name = basename(file)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const dir = join(dirname(file), `${stem}-versions`)
  mkdirSync(dir, { recursive: true })
  const stamp = new Date(opts.now ?? Date.now()).toISOString().replace(/[:.]/g, '-')
  copyFileSync(file, join(dir, `${stamp}${ext || '.bak'}`))
  const kept = readdirSync(dir)
    .filter(f => f.endsWith(ext || '.bak'))
    .sort()
  for (const old of kept.slice(0, -maxVersions)) {
    try {
      unlinkSync(join(dir, old))
    } catch {
      /* best-effort prune */
    }
  }
}
