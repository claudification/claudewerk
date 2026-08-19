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

/** Pages between automatic WAL checkpoints. 1000 (~4 MB) is SQLite's own
 *  default; stating it makes the knob visible instead of implied. */
const STORE_WAL_AUTOCHECKPOINT_PAGES = 1000

/**
 * Open the main store (store.db) -- the one multi-GB database the broker keeps
 * open for its whole life.
 *
 * It used to be the only database in the broker opened with a bare
 * `new Database(...)`, skipping every pragma the small stores get: no explicit
 * journal_mode, no autocheckpoint, and a 2 MB page cache against a 10 GB file.
 * A larger cache is the point here -- the small-store 2 MB default turns
 * ordinary reads into disk traffic at this size.
 */
export function openStoreDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { strict: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA cache_size = -65536') // 64MB -- this is the big one
  db.run(`PRAGMA wal_autocheckpoint = ${STORE_WAL_AUTOCHECKPOINT_PAGES}`)
  return db
}
