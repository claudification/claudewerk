import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openBrokerDatabase } from '../sqlite-open'
import { archiveName } from './month'
import { readNdjsonZstd } from './ndjson'
import { TRANSCRIPT_COLUMNS } from './types'

export interface ImportOptions {
  archiveDir: string
  month: string
  /** Database to load into. Defaults to the live store.db in `cacheDir`. */
  cacheDir: string
  targetDb?: string
}

export interface ImportResult {
  month: string
  read: number
  inserted: number
  skipped: number
}

const BATCH = 2_000

/** Rehydrate an archived month back into a database.
 *
 *  `INSERT OR IGNORE` against the (conversation_id, uuid) unique key, so
 *  importing a month that is already partly present is safe and idempotent --
 *  re-running after an interrupted import does the right thing rather than
 *  duplicating. Explicit `id` is preserved so ids stay stable across the
 *  archive round-trip. */
export async function importMonth(opts: ImportOptions): Promise<ImportResult> {
  const { archiveDir, month, cacheDir, targetDb } = opts
  const archivePath = join(archiveDir, archiveName(month))
  if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`)

  const dbPath = targetDb || join(cacheDir, 'store.db')
  if (!existsSync(dbPath)) throw new Error(`Target database not found: ${dbPath}`)

  const db = openBrokerDatabase(dbPath)
  const cols = TRANSCRIPT_COLUMNS.join(', ')
  const placeholders = TRANSCRIPT_COLUMNS.map(c => `$${c}`).join(', ')
  const insert = db.prepare(`INSERT OR IGNORE INTO transcript_entries (${cols}) VALUES (${placeholders})`)

  let read = 0
  let inserted = 0
  let batchOpen = false

  const beginBatch = () => {
    if (!batchOpen) {
      db.run('BEGIN')
      batchOpen = true
    }
  }
  const commitBatch = () => {
    if (batchOpen) {
      db.run('COMMIT')
      batchOpen = false
    }
  }

  try {
    console.log(`Importing ${month} into ${dbPath}...`)
    await readNdjsonZstd(archivePath, row => {
      beginBatch()
      // bun:sqlite bind keys carry NO `$` prefix -- SQL `$name` binds as `name`.
      const params: Record<string, unknown> = {}
      for (const c of TRANSCRIPT_COLUMNS) params[c] = row[c] ?? null
      const info = insert.run(params as never)
      if (info.changes > 0) inserted++
      read++
      if (read % BATCH === 0) {
        commitBatch()
        if (read % 50_000 === 0) console.log(`  ${read.toLocaleString()} rows...`)
      }
    })
    commitBatch()

    // External-content FTS needs a nudge after a bulk load to keep queries fast.
    try {
      db.run(`INSERT INTO transcript_fts(transcript_fts) VALUES('optimize')`)
    } catch {
      // FTS may not exist on a scratch target; not fatal for an import.
    }

    const skipped = read - inserted
    console.log(
      `\nImported ${month}: ${inserted.toLocaleString()} inserted, ${skipped.toLocaleString()} already present`,
    )
    return { month, read, inserted, skipped }
  } catch (err) {
    if (batchOpen) db.run('ROLLBACK')
    throw err
  } finally {
    db.close()
  }
}
