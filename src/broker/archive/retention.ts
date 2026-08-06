import { join } from 'node:path'
import { openBrokerDatabase } from '../sqlite-open'
import { monthRange } from './month'
import type { ArchiveMeta } from './types'
import { readMeta, verifyArchive } from './verify'

export interface RetentionOptions {
  cacheDir: string
  archiveDir: string
  month: string
  /** Nothing is deleted unless this is explicitly true. */
  confirm?: boolean
}

export interface RetentionResult {
  month: string
  deleted: number
  /** True when rows were actually removed (false for a dry run). */
  applied: boolean
  reason: string
}

function refuse(month: string, reason: string): RetentionResult {
  return { month, deleted: 0, applied: false, reason }
}

/** The transactional delete.
 *
 *  Counts rather than trusting `run().changes`: transcript_entries carries FTS
 *  shadow triggers whose writes are folded into the reported change count
 *  (deleting 5 rows reports 15). A COUNT on both sides is unambiguous. */
function deleteRange(cacheDir: string, meta: ArchiveMeta): RetentionResult {
  const { month } = meta
  const { start, end } = monthRange(month)
  const db = openBrokerDatabase(join(cacheDir, 'store.db'))

  const countInRange = () =>
    (
      db
        .query('SELECT COUNT(*) AS n FROM transcript_entries WHERE timestamp >= $start AND timestamp < $end')
        .get({ start, end }) as { n: number }
    ).n

  try {
    db.run('BEGIN IMMEDIATE')

    const deleted = countInRange()
    if (deleted !== meta.rows) {
      db.run('ROLLBACK')
      return refuse(
        month,
        `ROLLED BACK: database holds ${deleted} rows in ${month} but the archive covers ${meta.rows} -- re-export ${month} and retry`,
      )
    }

    db.prepare('DELETE FROM transcript_entries WHERE timestamp >= $start AND timestamp < $end').run({ start, end })

    const remaining = countInRange()
    if (remaining !== 0) {
      db.run('ROLLBACK')
      return refuse(month, `ROLLED BACK: ${remaining} rows still present in ${month} after the delete`)
    }

    db.run('COMMIT')

    // The FTS delete triggers fired row-by-row inside the transaction; optimize
    // compacts the resulting index. Best-effort -- a failure costs query speed,
    // not correctness.
    try {
      db.run(`INSERT INTO transcript_fts(transcript_fts) VALUES('optimize')`)
    } catch {
      // non-fatal
    }

    return { month, deleted, applied: true, reason: `deleted ${deleted.toLocaleString()} archived rows` }
  } catch (err) {
    try {
      db.run('ROLLBACK')
    } catch {
      // transaction may already be closed
    }
    throw err
  } finally {
    db.close()
  }
}

/** Delete a month's rows from the hot database, but ONLY after its cold archive
 *  verifies against the live database.
 *
 *  The safety is layered on purpose, because this is the one genuinely
 *  irreversible operation in the whole backup system:
 *
 *    1. the archive must exist, be intact, and hash-match its meta
 *    2. every row it contains must still hash-match the database rows it covers
 *    3. the delete runs in a transaction that COUNTs before and after, and bails
 *       unless both numbers line up -- a late row landing in an already-archived
 *       month rolls the whole thing back instead of being destroyed
 *    4. nothing runs at all without an explicit confirm
 *
 *  A rollback is not a failure mode to work around; it means "re-export, then
 *  try again", and the data is untouched in the meantime. */
export async function pruneArchivedMonth(opts: RetentionOptions): Promise<RetentionResult> {
  const { cacheDir, archiveDir, month, confirm = false } = opts

  const meta = readMeta(archiveDir, month)
  if (!meta) return refuse(month, `no archive meta for ${month} -- export it first`)

  const verdict = await verifyArchive(archiveDir, month, { cacheDir })
  if (!verdict.ok) return refuse(month, `archive verification FAILED: ${verdict.problems.join('; ')}`)
  if (!verdict.matchedDatabase) return refuse(month, 'archive did not match the live database')

  if (!confirm) {
    return {
      month,
      deleted: meta.rows,
      applied: false,
      reason: `dry run -- would delete ${meta.rows.toLocaleString()} verified rows (pass --confirm to apply)`,
    }
  }

  return deleteRange(cacheDir, meta)
}
