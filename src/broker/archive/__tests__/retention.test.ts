import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportMonth } from '../export'
import { monthsToArchive } from '../list'
import { pruneArchivedMonth } from '../retention'
import { countRows, makeStoreDb, seedMonths } from './fixture'

let root: string
let cacheDir: string
let archiveDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'archive-ret-'))
  cacheDir = join(root, 'cache')
  archiveDir = join(root, 'archives')
  makeStoreDb(cacheDir)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function ftsCount(): number {
  const db = new Database(join(cacheDir, 'store.db'), { strict: true, readonly: true })
  try {
    return (
      db.query(`SELECT COUNT(*) AS n FROM transcript_fts WHERE transcript_fts MATCH 'entry'`).get() as { n: number }
    ).n
  } finally {
    db.close()
  }
}

test('refuses to delete without confirm', async () => {
  seedMonths(cacheDir, [{ month: '2026-06', rows: 50 }])
  await exportMonth({ cacheDir, archiveDir, month: '2026-06' })

  const res = await pruneArchivedMonth({ cacheDir, archiveDir, month: '2026-06' })
  expect(res.applied).toBe(false)
  expect(res.reason).toContain('dry run')
  expect(countRows(cacheDir)).toBe(50)
})

test('refuses to delete when no archive exists', async () => {
  seedMonths(cacheDir, [{ month: '2026-06', rows: 10 }])
  const res = await pruneArchivedMonth({ cacheDir, archiveDir, month: '2026-06', confirm: true })
  expect(res.applied).toBe(false)
  expect(res.reason).toContain('no archive meta')
  expect(countRows(cacheDir)).toBe(10)
})

test('deletes only the archived month and keeps the FTS index in step', async () => {
  seedMonths(cacheDir, [
    { month: '2026-05', rows: 20 },
    { month: '2026-06', rows: 30 },
    { month: '2026-07', rows: 40 },
  ])
  expect(countRows(cacheDir)).toBe(90)
  const ftsBefore = ftsCount()
  expect(ftsBefore).toBe(90)

  await exportMonth({ cacheDir, archiveDir, month: '2026-06' })
  const res = await pruneArchivedMonth({ cacheDir, archiveDir, month: '2026-06', confirm: true })

  expect(res.applied).toBe(true)
  expect(res.deleted).toBe(30)
  expect(countRows(cacheDir)).toBe(60)
  // The AFTER DELETE trigger must have pulled those rows out of FTS too;
  // a stale index would keep answering for deleted content.
  expect(ftsCount()).toBe(60)
})

// The core safety property: if the month drifted after export, the delete must
// roll back rather than destroy rows the archive does not cover.
test('ROLLS BACK when a late row landed in an already-archived month', async () => {
  seedMonths(cacheDir, [{ month: '2026-06', rows: 25 }])
  await exportMonth({ cacheDir, archiveDir, month: '2026-06' })

  const db = new Database(join(cacheDir, 'store.db'), { strict: true })
  db.run(
    `INSERT INTO transcript_entries
     (conversation_id, seq, sync_epoch, type, uuid, content, timestamp, ingested_at)
     VALUES ('conv_late', 999, 'e', 'user', 'late-uuid', 'arrived after the export', ?, ?)`,
    [Date.UTC(2026, 5, 28), Date.UTC(2026, 5, 28)],
  )
  db.close()
  expect(countRows(cacheDir)).toBe(26)

  const res = await pruneArchivedMonth({ cacheDir, archiveDir, month: '2026-06', confirm: true })

  expect(res.applied).toBe(false)
  expect(res.deleted).toBe(0)
  // Nothing lost -- not the 25 archived rows, not the late one.
  expect(countRows(cacheDir)).toBe(26)
})

test('re-exporting after drift lets the delete proceed', async () => {
  seedMonths(cacheDir, [{ month: '2026-06', rows: 25 }])
  await exportMonth({ cacheDir, archiveDir, month: '2026-06' })

  const db = new Database(join(cacheDir, 'store.db'), { strict: true })
  db.run(
    `INSERT INTO transcript_entries
     (conversation_id, seq, sync_epoch, type, uuid, content, timestamp, ingested_at)
     VALUES ('conv_late', 999, 'e', 'user', 'late-uuid', 'late', ?, ?)`,
    [Date.UTC(2026, 5, 28), Date.UTC(2026, 5, 28)],
  )
  db.close()

  expect((await pruneArchivedMonth({ cacheDir, archiveDir, month: '2026-06', confirm: true })).applied).toBe(false)

  await exportMonth({ cacheDir, archiveDir, month: '2026-06', force: true })
  const res = await pruneArchivedMonth({ cacheDir, archiveDir, month: '2026-06', confirm: true })
  expect(res.applied).toBe(true)
  expect(res.deleted).toBe(26)
  expect(countRows(cacheDir)).toBe(0)
})

test('monthsToArchive leaves the current month and any month still inside the window', () => {
  const now = Date.UTC(2026, 7, 7) // 2026-08-07
  seedMonths(cacheDir, [
    { month: '2026-03', rows: 5 },
    { month: '2026-06', rows: 5 },
    { month: '2026-08', rows: 5 },
  ])

  // 90-day window from 2026-08-07 reaches back to ~2026-05-09, so June is still hot.
  expect(monthsToArchive(cacheDir, 90, now)).toEqual(['2026-03'])
  // A 30-day window pulls June out too, but never the current month.
  expect(monthsToArchive(cacheDir, 30, now)).toEqual(['2026-03', '2026-06'])
})
