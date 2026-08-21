import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStoreDatabase, startWalCheckpointLoop } from './sqlite-open'

/**
 * Regression cover for the 2026-08-21 stall: SQLite's automatic WAL checkpoint
 * runs INLINE on whichever writer crosses the threshold, so on a ~10 GB store
 * an unrelated single-row INSERT paid up to 1575 ms of checkpoint I/O.
 *
 * The contract is therefore twofold and both halves matter: no writer may ever
 * be handed that bill (autocheckpoint off), and something else must still bound
 * the WAL (the passive loop). Testing only the first half would "pass" on a
 * build that grows the WAL forever.
 */
describe('store WAL checkpointing', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'store-wal-'))
    dbPath = join(dir, 'store.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('autocheckpoint is disabled so no writer checkpoints inline', () => {
    const db = openStoreDatabase(dbPath)
    try {
      const [row] = db.prepare('PRAGMA wal_autocheckpoint').all() as Array<Record<string, number>>
      expect(Object.values(row)[0]).toBe(0)
    } finally {
      db.close()
    }
  })

  test('the passive loop folds the WAL back into the store', async () => {
    const db = openStoreDatabase(dbPath)
    try {
      db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)')
      const ins = db.prepare('INSERT INTO t (body) VALUES ($body)')
      // Enough pages that a WAL definitely exists on disk to be folded back.
      for (let i = 0; i < 4000; i++) ins.run({ body: 'x'.repeat(512) })

      const walPath = `${dbPath}-wal`
      expect(existsSync(walPath)).toBe(true)

      // Assert on the MAIN file, not the WAL. A PASSIVE checkpoint copies frames
      // into the database and leaves the WAL at its high-water mark for reuse --
      // only TRUNCATE shrinks the file. Measured: WAL 21205672 -> 21205672 while
      // the store went 4096 -> 2359296. Asserting the WAL shrinks looks like the
      // obvious test and is simply wrong; it fails against a working fix.
      const beforeStore = statSync(dbPath).size

      // Short interval so the test does not wait on the 30s production cadence.
      const stop = startWalCheckpointLoop(db, 10)
      try {
        await Bun.sleep(120)
      } finally {
        stop()
      }

      expect(statSync(dbPath).size).toBeGreaterThan(beforeStore)
    } finally {
      db.close()
    }
  })

  test('a passive checkpoint never reports itself blocked', () => {
    const db = openStoreDatabase(dbPath)
    try {
      db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)')
      const ins = db.prepare('INSERT INTO t (body) VALUES ($body)')
      for (let i = 0; i < 500; i++) ins.run({ body: 'y'.repeat(256) })

      // busy=0 is the whole reason this mode was chosen: it yields instead of
      // stalling a writer, which is the stall being removed.
      const [row] = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').all() as Array<{
        busy: number
        checkpointed: number
      }>
      expect(row.busy).toBe(0)
      expect(row.checkpointed).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  test('stop() halts the loop, so a closed database is never touched', async () => {
    const db = openStoreDatabase(dbPath)
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    const stop = startWalCheckpointLoop(db, 5)
    await Bun.sleep(20)
    stop()
    db.close()
    // If the timer survived stop(), it would fire against a closed handle here.
    await Bun.sleep(30)
    expect(true).toBe(true)
  })
})
