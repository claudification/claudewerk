import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeStoreDb, seedMonths } from '../../archive/__tests__/fixture'
import { reclaimPhase } from '../phases'
import { Runner } from '../runner'
import type { MaintenanceOptions } from '../types'

/** The 2026-08-19 incident, as a test.
 *
 *  In WAL mode a VACUUM rewrites the ENTIRE database through the WAL, so a
 *  9.7 GB store produced a 10.4 GB WAL -- and the checkpoint step ran BEFORE
 *  the vacuum, so nothing ever truncated it. The broker then carried that file
 *  for 24h: every read dragged it through the page cache (~250 MB/s of churn,
 *  a 6 GB sawtooth in the container's memory, 295% CPU) and every backup copied
 *  it. The fix is ordering -- checkpoint again AFTER the vacuum.
 *
 *  These drive reclaimPhase directly rather than the whole nightly run. The
 *  full pipeline hides the bug: the smoketest that follows the vacuum opens and
 *  closes its own connections, and that incidental churn cleans the WAL up. The
 *  ordering defect lives in this phase, so this is where it gets pinned. */

let root: string
let cacheDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wal-vac-'))
  cacheDir = join(root, 'cache')
  makeStoreDb(cacheDir)
  // The fixture leaves the default rollback journal. The bug only exists in WAL
  // mode, so putting the database in WAL is the precondition, not incidental.
  const db = new Database(join(cacheDir, 'store.db'), { strict: true })
  db.run('PRAGMA journal_mode = WAL')
  db.close()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function opts(over: Partial<MaintenanceOptions> = {}): MaintenanceOptions {
  return { cacheDir, backupDir: root, archiveDir: root, hotDays: 90, maxBackupAgeMinutes: 90, ...over }
}

function sizeOf(suffix: string): number {
  try {
    return statSync(join(cacheDir, `store.db${suffix}`)).size
  } catch {
    return 0
  }
}

/** Stand in for the live broker.
 *
 *  Holding a connection is what makes the bug reproduce. SQLite truncates the
 *  WAL when the LAST connection closes, so maintenance against an idle database
 *  cleans up after itself by accident; the production broker holds store.db
 *  open around the clock and never gives it that chance. Opening alone is not
 *  enough either -- bun:sqlite does not touch the file until the first
 *  statement. */
function attachBroker(): Database {
  const db = new Database(join(cacheDir, 'store.db'), { strict: true })
  db.query('SELECT COUNT(*) AS n FROM transcript_entries').get()
  return db
}

// Enough rows that a VACUUM moves megabytes: at ~200 bytes of content each plus
// the FTS index, a WAL left behind by the vacuum is unmistakable against the
// few KB a truncated one leaves.
const BULK_ROWS = 20_000

test('leaves the WAL truncated after a VACUUM, with the broker still attached', async () => {
  seedMonths(cacheDir, [{ month: '2026-01', rows: BULK_ROWS }])
  const broker = attachBroker()
  try {
    const r = new Runner()
    await reclaimPhase(r, opts(), BULK_ROWS)

    expect(r.steps.find(s => s.step === 'vacuum')?.status).toBe('ok')

    // The vacuum's own writes must not be left sitting in the WAL. A truncated
    // WAL is a handful of KB; the bug left it at roughly the size of the whole
    // database -- 1.01x here, and 10.4 GB against a 10.2 GB store in production.
    const wal = sizeOf('-wal')
    const db = sizeOf('')
    expect(db).toBeGreaterThan(4 * 1024 * 1024)
    expect(wal).toBeLessThan(1024 * 1024)
    expect(wal).toBeLessThan(db / 4)
  } finally {
    broker.close()
  }
})

test('checkpoints again after the vacuum, not only before it', async () => {
  seedMonths(cacheDir, [{ month: '2026-01', rows: 200 }])
  const broker = attachBroker()
  try {
    const r = new Runner()
    await reclaimPhase(r, opts(), 200)

    // Ordering is the fix. A checkpoint that only runs before the vacuum cannot
    // clean up what the vacuum writes.
    const names = r.steps.map(s => s.step)
    const vacuumAt = names.indexOf('vacuum')
    expect(vacuumAt).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('checkpoint:post-vacuum')).toBeGreaterThan(vacuumAt)
  } finally {
    broker.close()
  }
})

test('skips the VACUUM entirely when the delete phase reclaimed nothing', async () => {
  seedMonths(cacheDir, [{ month: '2026-01', rows: 500 }])
  const broker = attachBroker()
  try {
    // rowsDeleted = 0 is the CONFIRM_DELETE-off case that runs in production
    // every night: archives get written, rows stay, and there are no freed pages
    // to reclaim. A VACUUM there is a full-database rewrite for zero benefit --
    // 264s and a 10 GB WAL, nightly.
    const r = new Runner()
    await reclaimPhase(r, opts(), 0)

    const vacuum = r.steps.find(s => s.step === 'vacuum')
    expect(vacuum?.status).toBe('skipped')
    expect(vacuum?.detail).toContain('nothing deleted')
  } finally {
    broker.close()
  }
})

test('still vacuums when rows were deleted, even a few', async () => {
  seedMonths(cacheDir, [{ month: '2026-01', rows: 500 }])
  const broker = attachBroker()
  try {
    const r = new Runner()
    await reclaimPhase(r, opts(), 1)
    expect(r.steps.find(s => s.step === 'vacuum')?.status).toBe('ok')
  } finally {
    broker.close()
  }
})
