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
