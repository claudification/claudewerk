import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openBrokerDatabase } from '../sqlite-open'

export function storeDbPath(cacheDir: string): string {
  return join(cacheDir, 'store.db')
}

export function dbSizeBytes(cacheDir: string): number {
  const p = storeDbPath(cacheDir)
  if (!existsSync(p)) return 0
  let total = statSync(p).size
  for (const suffix of ['-wal', '-shm']) {
    const side = `${p}${suffix}`
    if (existsSync(side)) total += statSync(side).size
  }
  return total
}

export function transcriptRowCount(cacheDir: string): number {
  const p = storeDbPath(cacheDir)
  if (!existsSync(p)) return 0
  const db = openBrokerDatabase(p, { readonly: true })
  try {
    return (db.query('SELECT COUNT(*) AS n FROM transcript_entries').get() as { n: number }).n
  } finally {
    db.close()
  }
}

/** Fold the WAL back into the main database and truncate it.
 *
 *  The WAL had grown to 675 MB, which is 675 MB that every backup copies and
 *  every restart replays. TRUNCATE (not PASSIVE) is the point -- PASSIVE leaves
 *  the file at its high-water mark. */
export function checkpointWal(cacheDir: string): string {
  const db = openBrokerDatabase(storeDbPath(cacheDir))
  try {
    const row = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
      busy: number
      log: number
      checkpointed: number
    } | null
    if (!row) return 'checkpoint returned no result'
    if (row.busy !== 0) return `busy=${row.busy} -- readers held the WAL open, checkpoint incomplete`
    return `checkpointed ${row.checkpointed} frames, WAL truncated`
  } finally {
    db.close()
  }
}

/** Reclaim the pages freed by the retention delete.
 *
 *  VACUUM needs free disk roughly equal to the database size because it builds
 *  a complete new file before swapping. Callers check headroom first; running
 *  out of space mid-VACUUM is recoverable (SQLite rolls back) but wastes the
 *  whole nightly window. */
export function vacuumDatabase(cacheDir: string): string {
  const before = statSync(storeDbPath(cacheDir)).size
  const db = openBrokerDatabase(storeDbPath(cacheDir))
  try {
    db.run('VACUUM')
  } finally {
    db.close()
  }
  const after = statSync(storeDbPath(cacheDir)).size
  const savedMb = (before - after) / 1024 / 1024
  return `${(before / 1024 / 1024).toFixed(0)} MB -> ${(after / 1024 / 1024).toFixed(0)} MB (reclaimed ${savedMb.toFixed(0)} MB)`
}

/** Free bytes on the filesystem holding the cache dir. */
export function freeSpaceBytes(cacheDir: string): number {
  const out = Bun.spawnSync(['df', '-Pk', cacheDir], { stdout: 'pipe', stderr: 'ignore' })
  if (out.exitCode !== 0) return Number.POSITIVE_INFINITY
  const line = out.stdout.toString().trim().split('\n')[1]
  const cols = line?.trim().split(/\s+/)
  const availKb = cols ? parseInt(cols[3], 10) : NaN
  return Number.isNaN(availKb) ? Number.POSITIVE_INFINITY : availKb * 1024
}
