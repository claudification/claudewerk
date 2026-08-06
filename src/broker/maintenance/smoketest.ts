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

function rowCountCheck(db: Database, expected: { rowsAfter: number; minRows: number }): SmokeCheck {
  const row = db.query('SELECT COUNT(*) AS n FROM transcript_entries').get() as { n: number }
  if (row.n < expected.minRows) {
    return {
      name: 'row count',
      ok: false,
      detail: `${row.n.toLocaleString()} rows is below the floor of ${expected.minRows.toLocaleString()} -- deleted too much`,
    }
  }
  if (row.n !== expected.rowsAfter) {
    return {
      name: 'row count',
      ok: false,
      detail: `expected ${expected.rowsAfter.toLocaleString()} rows, found ${row.n.toLocaleString()}`,
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
