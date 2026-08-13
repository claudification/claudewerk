/**
 * The filesystem half of the vacuum estimate.
 *
 * These sweeps never touch store.db, so they need no backup gate and no cold
 * archive -- they are derived artifacts a rebuild or a re-run regenerates.
 * They are also, measured against a 10 GB database, small: SOTU is the only one
 * above 100 MB. They are included because they are free and honest, not because
 * they are where the space is.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { FileSweepEstimate } from './types'

interface SweepSpec {
  key: string
  label: string
  /** Directory under the cache dir. */
  dir: string
  /** Files older than this many days match. */
  defaultDays: number
}

/** Recap bundles and SOTU snapshots are regenerable; blobs already carry a
 *  7-day TTL reaper, so this row only ever shows what that reaper missed. */
const FILE_SWEEPS: SweepSpec[] = [
  { key: 'sotu', label: 'SOTU snapshots', dir: 'sotu', defaultDays: 30 },
  { key: 'recaps', label: 'Recap artifacts', dir: 'recaps', defaultDays: 90 },
  { key: 'blobs', label: 'Blobs past their TTL', dir: 'blobs', defaultDays: 7 },
  { key: 'crashes', label: 'Crash dumps', dir: 'crashes', defaultDays: 30 },
]

interface WalkResult {
  files: number
  bytes: number
  matchedFiles: number
  matchedBytes: number
}

/** Recursive size + age walk. Symlinks are counted but never followed, so a
 *  loop cannot hang the estimate and a link out of the cache dir cannot make a
 *  sweep propose deleting something outside it. */
function walk(dir: string, cutoffMs: number, depth = 0): WalkResult {
  const acc: WalkResult = { files: 0, bytes: 0, matchedFiles: 0, matchedBytes: 0 }
  if (depth > 12 || !existsSync(dir)) return acc

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      const sub = walk(path, cutoffMs, depth + 1)
      acc.files += sub.files
      acc.bytes += sub.bytes
      acc.matchedFiles += sub.matchedFiles
      acc.matchedBytes += sub.matchedBytes
      continue
    }
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(path)
    } catch {
      continue // raced with a writer; it is not ours to report on
    }
    acc.files += 1
    acc.bytes += st.size
    if (st.mtimeMs < cutoffMs) {
      acc.matchedFiles += 1
      acc.matchedBytes += st.size
    }
  }
  return acc
}

function measureFileSweep(cacheDir: string, spec: SweepSpec, days: number, now = Date.now()): FileSweepEstimate {
  const path = join(cacheDir, spec.dir)
  const configured = existsSync(path)
  const result = configured
    ? walk(path, now - days * 86_400_000)
    : { files: 0, bytes: 0, matchedFiles: 0, matchedBytes: 0 }

  return { key: spec.key, label: spec.label, path, configured, ...result }
}

export function measureFileSweeps(
  cacheDir: string,
  ages: Record<string, number> = {},
  now = Date.now(),
): FileSweepEstimate[] {
  return FILE_SWEEPS.map(spec => measureFileSweep(cacheDir, spec, ages[spec.key] ?? spec.defaultDays, now))
}

/** Canvas scene files with no row in canvases.db.
 *
 *  Kept separate from the mtime sweeps because age is the wrong question here:
 *  a scene is garbage when nothing references it, however recently it was
 *  written, and a *recent* scene whose canvas still exists must never be swept
 *  no matter how the age threshold is set. */
export function measureOrphanedScenes(cacheDir: string, canvasDb: Database | null): FileSweepEstimate {
  const path = join(cacheDir, 'canvas-scenes')
  const configured = existsSync(path) && canvasDb !== null

  const empty = { files: 0, bytes: 0, matchedFiles: 0, matchedBytes: 0 }
  if (!configured) {
    return { key: 'canvas-scenes', label: 'Orphaned canvas scenes', path, configured: false, ...empty }
  }

  const live = new Set(
    (canvasDb.query('SELECT id FROM canvases').all() as Array<{ id: string }>).map(r => r.id),
  )

  const acc = { ...empty }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    let size: number
    try {
      size = statSync(join(path, entry.name)).size
    } catch {
      continue
    }
    acc.files += 1
    acc.bytes += size
    // "{canvasId}.excalidraw" / "{canvasId}.png" -- the id is everything before
    // the first dot, matching how canvas-scenes.ts names them.
    const canvasId = entry.name.split('.')[0]
    if (!live.has(canvasId)) {
      acc.matchedFiles += 1
      acc.matchedBytes += size
    }
  }

  return { key: 'canvas-scenes', label: 'Orphaned canvas scenes', path, configured: true, ...acc }
}
