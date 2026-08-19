import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openBrokerDatabase } from '../sqlite-open'

export interface SmokeCheck {
  name: string
  ok: boolean
  detail: string
}

/** Post-maintenance validation.
 *
 *  This runs AFTER rows have been deleted and the file rewritten, which is
 *  exactly the moment a silent corruption would be most expensive to miss. Every
 *  check here is cheap relative to restoring from backup. */
export async function runSmoketest(
  cacheDir: string,
  expected: { rowsAfter: number; minRows: number },
  healthUrl?: string,
): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = []
  const dbPath = join(cacheDir, 'store.db')

  if (!existsSync(dbPath)) {
    return [{ name: 'store.db exists', ok: false, detail: `${dbPath} is missing` }]
  }

  const db = openBrokerDatabase(dbPath, { readonly: true })
  try {
    checks.push(integrityCheck(db))
    checks.push(ftsQueryCheck(db))
    checks.push(rowCountCheck(db, expected))
    checks.push(foreignKeyCheck(db))
  } finally {
    db.close()
  }

  if (healthUrl) checks.push(await healthCheck(healthUrl))
  return checks
}

function integrityCheck(db: Database): SmokeCheck {
  // quick_check skips the (very slow) full index cross-reference but still
  // catches page-level damage -- the right tradeoff for a nightly gate.
  const rows = db.query('PRAGMA quick_check').all() as Array<Record<string, string>>
  const first = rows[0] ? Object.values(rows[0])[0] : 'no result'
  return { name: 'quick_check', ok: first === 'ok', detail: String(first) }
}

function foreignKeyCheck(db: Database): SmokeCheck {
  const rows = db.query('PRAGMA foreign_key_check').all()
  return {
    name: 'foreign_key_check',
    ok: rows.length === 0,
    detail: rows.length === 0 ? 'no violations' : `${rows.length} violation(s)`,
  }
}

/** The FTS index is dropped and rebuilt around backups and loses rows on a bad
 *  delete, so prove it still answers rather than assuming it does. */
function ftsQueryCheck(db: Database): SmokeCheck {
  try {
    const row = db.query(`SELECT COUNT(*) AS n FROM transcript_fts WHERE transcript_fts MATCH 'the'`).get() as {
      n: number
    } | null
    const n = row?.n ?? 0
    return { name: 'fts query', ok: true, detail: `matched ${n.toLocaleString()} rows for 'the'` }
  } catch (err) {
    return { name: 'fts query', ok: false, detail: `FTS query threw: ${(err as Error).message}` }
  }
}

/** How far below the floor the count may sit before it stops being explicable
 *  as ordinary traffic.
 *
 *  The broker is live throughout the run: clearConversation and the reaper drop
 *  transcript rows during the 264 seconds the VACUUM occupies, and the floor
 *  (`rowsBefore - rowsDeleted`) models only OUR deletions. 2026-08-14 and
 *  2026-08-18 both aborted on a shortfall while having deleted nothing at all --
 *  587 rows on 08-18. One percent of the database is far more room than live
 *  traffic needs and far less than a runaway delete would take. */
const CONCURRENT_CLEAR_ALLOWANCE = 0.01

function rowCountCheck(db: Database, expected: { rowsAfter: number; minRows: number }): SmokeCheck {
  const row = db.query('SELECT COUNT(*) AS n FROM transcript_entries').get() as { n: number }
  const shortfall = expected.minRows - row.n

  if (shortfall > 0) {
    const allowance = Math.ceil(expected.minRows * CONCURRENT_CLEAR_ALLOWANCE)
    if (shortfall > allowance) {
      return {
        name: 'row count',
        ok: false,
        detail: `${row.n.toLocaleString()} rows is ${shortfall.toLocaleString()} below the floor of ${expected.minRows.toLocaleString()} -- deleted too much`,
      }
    }
    // Reported, not fatal. An abort here skips every remaining step, and with
    // retention enabled that strands a run midway through an irreversible
    // delete. The real guarantee is deleteRange's in-transaction COUNT on both
    // sides, which rolls back rather than over-deleting.
    return {
      name: 'row count',
      ok: true,
      detail: `${row.n.toLocaleString()} rows -- ${shortfall.toLocaleString()} below the floor, within the ${allowance.toLocaleString()}-row concurrent-clear allowance`,
    }
  }

  if (row.n !== expected.rowsAfter) {
    return {
      name: 'row count',
      ok: true,
      detail: `${row.n.toLocaleString()} rows (expected ${expected.rowsAfter.toLocaleString()}; the broker kept writing while maintenance ran)`,
    }
  }
  return { name: 'row count', ok: true, detail: `${row.n.toLocaleString()} rows` }
}

async function healthCheck(url: string): Promise<SmokeCheck> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    return { name: 'broker health', ok: res.ok, detail: `${url} -> ${res.status}` }
  } catch (err) {
    return { name: 'broker health', ok: false, detail: `${url} unreachable: ${(err as Error).message}` }
  }
}
