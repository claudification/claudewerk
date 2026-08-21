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

/**
 * Automatic WAL checkpoints are DISABLED on the store, and that is the point.
 *
 * SQLite's autocheckpoint runs INLINE, on whichever writer happens to push the
 * WAL past the threshold. That writer then pays to fold the WAL back into the
 * main database -- and store.db is ~10 GB, so the bill is hundreds of
 * milliseconds of random I/O charged to an unrelated statement.
 *
 * Measured 2026-08-21: 108 of 123 logged slow queries were a single-row
 * `INSERT INTO tasks` -- a 7.5k-row table -- at up to 1575 ms, arriving at a
 * rate that tracked overall write volume rather than any clock. Dropping two
 * genuinely duplicated indexes on that table changed nothing, which is what
 * ruled write cost out and left the checkpoint.
 *
 * So: no writer checkpoints inline. `startWalCheckpointLoop` does it on a timer
 * in PASSIVE mode, which never blocks a writer and simply does less work when
 * the database is busy.
 */
const STORE_WAL_AUTOCHECKPOINT_PAGES = 0

/** How often the background loop folds the WAL back into the store. */
const WAL_CHECKPOINT_INTERVAL_MS = 30_000

/**
 * Fold the WAL back into the store off the critical path.
 *
 * PASSIVE is deliberate: it checkpoints only the pages it can take without
 * waiting, and yields the moment a reader or writer needs the file. A FULL or
 * TRUNCATE checkpoint here would reintroduce exactly the stall this removes.
 * With autocheckpoint off, this loop is the ONLY thing bounding WAL growth in
 * steady state -- if it stops, the WAL grows until `compact()` runs.
 *
 * Returns a stop function; callers must invoke it on close or the timer keeps
 * a dead database handle alive.
 */
export function startWalCheckpointLoop(db: Database, intervalMs = WAL_CHECKPOINT_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    try {
      db.run('PRAGMA wal_checkpoint(PASSIVE)')
    } catch (err) {
      // A checkpoint that loses a race is normal and self-correcting: the next
      // tick retries. Never let it take the broker down.
      console.warn('[store] passive WAL checkpoint failed:', err instanceof Error ? err.message : err)
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

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
