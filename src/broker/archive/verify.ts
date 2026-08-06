import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openBrokerDatabase } from '../sqlite-open'
import { archiveName, metaName } from './month'
import { readNdjsonZstd } from './ndjson'
import { type ArchiveMeta, TRANSCRIPT_COLUMNS, type VerifyResult } from './types'

export function readMeta(archiveDir: string, month: string): ArchiveMeta | null {
  const p = join(archiveDir, metaName(month))
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as ArchiveMeta
  } catch {
    return null
  }
}

/** Canonical per-row digest input. Column order is fixed by TRANSCRIPT_COLUMNS
 *  so the database side and the archive side serialise identically. */
function rowDigestInput(row: Record<string, unknown>): string {
  return JSON.stringify(TRANSCRIPT_COLUMNS.map(c => row[c] ?? null))
}

/** Verify an archive against its meta, and optionally against the live database.
 *
 *  The meta check proves the file is intact and complete. The database check
 *  proves it still corresponds to the rows we are about to delete -- that one is
 *  mandatory before any retention delete, because "the file is valid" and "the
 *  file contains what I am about to destroy" are different claims. */
export async function verifyArchive(
  archiveDir: string,
  month: string,
  opts: { cacheDir?: string } = {},
): Promise<VerifyResult> {
  const problems: string[] = []
  const archivePath = join(archiveDir, archiveName(month))

  if (!existsSync(archivePath)) {
    return { month, ok: false, rows: 0, problems: [`archive missing: ${archivePath}`] }
  }
  const meta = readMeta(archiveDir, month)
  if (!meta) {
    return { month, ok: false, rows: 0, problems: [`meta sidecar missing or unreadable for ${month}`] }
  }

  // Fold the archive into a per-row digest as we stream it, so we never hold
  // more than one row in memory regardless of archive size.
  const rowDigest = createHash('sha256')
  let lastId = -1
  let orderBroken = false

  const read = await readNdjsonZstd(archivePath, row => {
    rowDigest.update(rowDigestInput(row))
    const id = row.id as number
    if (id <= lastId) orderBroken = true
    lastId = id
  })

  if (read.plaintextSha256 !== meta.plaintextSha256) {
    problems.push(
      `plaintext sha256 mismatch (meta ${meta.plaintextSha256.slice(0, 12)}..., actual ${read.plaintextSha256.slice(0, 12)}...)`,
    )
  }
  if (read.rows !== meta.rows) problems.push(`row count mismatch (meta ${meta.rows}, actual ${read.rows})`)
  if (read.plaintextBytes !== meta.plaintextBytes) {
    problems.push(`plaintext size mismatch (meta ${meta.plaintextBytes}, actual ${read.plaintextBytes})`)
  }
  if (orderBroken) problems.push('rows are not in ascending id order')

  const result: VerifyResult = { month, ok: problems.length === 0, rows: read.rows, problems }
  if (!opts.cacheDir) return result

  result.matchedDatabase = verifyAgainstDatabase(opts.cacheDir, meta, rowDigest.digest('hex'), problems)
  result.ok = problems.length === 0
  return result
}

function verifyAgainstDatabase(
  cacheDir: string,
  meta: ArchiveMeta,
  archiveRowDigest: string,
  problems: string[],
): boolean {
  const dbPath = join(cacheDir, 'store.db')
  if (!existsSync(dbPath)) {
    problems.push(`store.db not found in ${cacheDir}`)
    return false
  }

  const db = openBrokerDatabase(dbPath, { readonly: true })
  try {
    const cols = TRANSCRIPT_COLUMNS.join(', ')
    const stmt = db.query(
      `SELECT ${cols} FROM transcript_entries WHERE timestamp >= $start AND timestamp < $end ORDER BY id`,
    )
    const dbDigest = createHash('sha256')
    let dbRows = 0
    for (const row of stmt.iterate({ start: meta.rangeStart, end: meta.rangeEnd }) as Iterable<
      Record<string, unknown>
    >) {
      dbDigest.update(rowDigestInput(row))
      dbRows++
    }

    if (dbRows !== meta.rows) {
      problems.push(
        `database has ${dbRows} rows in ${meta.month} but archive has ${meta.rows} -- re-export before deleting`,
      )
      return false
    }
    const dbHex = dbDigest.digest('hex')
    if (dbHex !== archiveRowDigest) {
      problems.push(`archive content does not match database rows for ${meta.month}`)
      return false
    }
    return true
  } finally {
    db.close()
  }
}
