import { Database } from 'bun:sqlite'

/**
 * Open a broker-local SQLite database with the standard durability pragmas:
 * WAL journaling, NORMAL synchronous, 2MB page cache. Shared by the small
 * config stores (projects, checklists) so the boilerplate lives in one place.
 */
export function openWalDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { strict: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA cache_size = -2000') // 2MB -- small table
  return db
}

/**
 * Open an existing broker database WITHOUT touching its pragmas -- for tools
 * (backup, archive, maintenance) that attach to a database the broker owns.
 *
 * `strict: true` is not optional. Without it bun:sqlite requires named params
 * to carry a literal `$` in the JS key, and a bare key binds silently as NULL
 * rather than throwing -- so a non-strict open turns a typo into quiet data
 * loss. Every other open in the broker is strict (see store/sqlite/driver.ts);
 * these match.
 */
export function openBrokerDatabase(dbPath: string, opts: { readonly?: boolean } = {}): Database {
  return new Database(dbPath, { strict: true, ...(opts.readonly && { readonly: true }) })
}
