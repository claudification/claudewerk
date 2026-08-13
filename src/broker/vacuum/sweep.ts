/**
 * The mutations the vacuum dialog can perform on its own.
 *
 * SCOPE IS DELIBERATELY NARROW: everything here is DERIVED data -- an index
 * SQLite can rebuild from `CREATE INDEX`, or a file the broker regenerates.
 * Nothing in this module deletes primary data, which is why none of it needs
 * the backup gate or a cold archive.
 *
 * Transcript rows are NOT swept here, and that is the whole design. The only
 * path that removes transcript rows is `pruneArchivedMonth`, which deletes a
 * whole UTC month and only after its cold archive has been verified against the
 * live database. A second delete path -- not month-aligned, not archive-gated --
 * is exactly the thing that turns a reclaim feature into a data-loss feature.
 *
 * That includes the orphan rows (transcripts whose conversation no longer
 * exists). They looked like an obvious sweep target, but on the live database
 * every one of them sits in a month that is already an archive candidate, so
 * the month prune reclaims 100% of them and a sweeper would buy nothing. See
 * .rclaude/project/cards/transcript-orphan-rows-leak.md.
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { openBrokerDatabase } from '../sqlite-open'
import { walkFiles } from './fs-walk'
import type { FileSweepEstimate, RedundantIndex } from './types'

export interface SweepOutcome {
  /** What was acted on, for the report and the wire message. */
  target: string
  applied: boolean
  detail: string
  bytesReclaimed: number
}

/** Drop indexes whose column list exactly duplicates another index.
 *
 *  Safe by construction: an index carries no data of its own, and the surviving
 *  duplicate answers every query the dropped one did. Reversible with a single
 *  CREATE INDEX, whose exact text is recorded in the outcome detail so the undo
 *  never has to be reconstructed from memory.
 *
 *  Freed pages land on the freelist; only VACUUM returns them to the OS. */
export function dropRedundantIndexes(cacheDir: string, indexes: RedundantIndex[], confirm: boolean): SweepOutcome[] {
  if (indexes.length === 0) return []
  if (!confirm) {
    return indexes.map(idx => ({
      target: idx.name,
      applied: false,
      detail: `dry run -- would DROP INDEX ${idx.name} (duplicate of ${idx.duplicateOf} on ${idx.columns.join(', ')})`,
      bytesReclaimed: 0,
    }))
  }

  const db = openBrokerDatabase(join(cacheDir, 'store.db'))
  try {
    return indexes.map(idx => {
      const recreate = `CREATE INDEX ${idx.name} ON ${idx.table}(${idx.columns.join(', ')})`
      try {
        // Re-check the duplicate still exists rather than trusting an estimate
        // that may be minutes old: dropping the ONLY index on a column would
        // silently cost every query that relies on it.
        const survivor = db
          .query(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = $name`)
          .get({ name: idx.duplicateOf }) as { name: string } | null
        if (!survivor) {
          return {
            target: idx.name,
            applied: false,
            detail: `SKIPPED -- ${idx.duplicateOf} is gone, so ${idx.name} is no longer redundant`,
            bytesReclaimed: 0,
          }
        }
        db.run(`DROP INDEX IF EXISTS ${idx.name}`)
        return {
          target: idx.name,
          applied: true,
          detail: `dropped (duplicate of ${idx.duplicateOf}); undo with: ${recreate}`,
          bytesReclaimed: idx.projectedBytes,
        }
      } catch (err) {
        return {
          target: idx.name,
          applied: false,
          detail: `FAILED: ${(err as Error).message}`,
          bytesReclaimed: 0,
        }
      }
    })
  } finally {
    db.close()
  }
}

export interface FileSweepRequest {
  estimate: FileSweepEstimate
  /** Age threshold the estimate was measured with, echoed into the report. */
  days: number
}

/** Delete the files a sweep estimate matched.
 *
 *  Re-walks rather than trusting a path list captured at estimate time, and
 *  re-checks each file's mtime immediately before removing it: an estimate is
 *  minutes old by the time a user confirms, and a file written in between must
 *  not be deleted because it happened to sit in a swept directory. */
export function sweepFiles(request: FileSweepRequest, confirm: boolean, now = Date.now()): SweepOutcome {
  const { estimate, days } = request
  if (!estimate.configured) {
    return { target: estimate.key, applied: false, detail: 'not configured on this broker', bytesReclaimed: 0 }
  }
  if (estimate.matchedFiles === 0) {
    return { target: estimate.key, applied: false, detail: `nothing older than ${days}d`, bytesReclaimed: 0 }
  }
  if (!confirm) {
    return {
      target: estimate.key,
      applied: false,
      detail: `dry run -- would delete ${estimate.matchedFiles} files older than ${days}d`,
      bytesReclaimed: 0,
    }
  }

  const cutoff = now - days * 86_400_000
  const matches: { path: string; bytes: number }[] = []
  walkFiles(estimate.path, file => {
    if (file.mtimeMs < cutoff) matches.push({ path: file.path, bytes: file.bytes })
  })

  let deleted = 0
  let bytes = 0
  let skipped = 0
  for (const match of matches) {
    try {
      rmSync(match.path)
      bytes += match.bytes
      deleted++
    } catch {
      skipped++
    }
  }

  const detail =
    skipped > 0
      ? `deleted ${deleted} files older than ${days}d, ${skipped} could not be removed`
      : `deleted ${deleted} files older than ${days}d`
  return { target: estimate.key, applied: deleted > 0, detail, bytesReclaimed: bytes }
}
