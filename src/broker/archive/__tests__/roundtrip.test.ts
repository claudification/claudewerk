import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportMonth } from '../export'
import { importMonth } from '../import'
import { archiveCoverage, monthsToArchive } from '../list'
import { archiveName, metaName } from '../month'
import { pruneArchivedMonth } from '../retention'
import { verifyArchive } from '../verify'
import { countRows, makeStoreDb, seedMonths } from './fixture'

let root: string
let cacheDir: string
let archiveDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'archive-rt-'))
  cacheDir = join(root, 'cache')
  archiveDir = join(root, 'archives')
  makeStoreDb(cacheDir)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('export -> verify -> import round-trips every column byte-exactly', async () => {
  seedMonths(cacheDir, [{ month: '2026-06', rows: 250 }])

  const before = new Database(join(cacheDir, 'store.db'), { readonly: true })
  const original = before.query('SELECT * FROM transcript_entries ORDER BY id').all()
  before.close()

  const meta = await exportMonth({ cacheDir, archiveDir, month: '2026-06' })
  expect(meta.rows).toBe(250)
  expect(meta.month).toBe('2026-06')

  const verdict = await verifyArchive(archiveDir, '2026-06', { cacheDir })
  expect(verdict.problems).toEqual([])
  expect(verdict.ok).toBe(true)
  expect(verdict.matchedDatabase).toBe(true)

  // Wipe the hot rows, then rehydrate purely from the cold archive.
  const wipe = new Database(join(cacheDir, 'store.db'))
  wipe.run('DELETE FROM transcript_entries')
  wipe.close()
  expect(countRows(cacheDir)).toBe(0)

  const imported = await importMonth({ archiveDir, month: '2026-06', cacheDir })
  expect(imported.inserted).toBe(250)

  const after = new Database(join(cacheDir, 'store.db'), { readonly: true })
  const restored = after.query('SELECT * FROM transcript_entries ORDER BY id').all()
  after.close()
  expect(restored).toEqual(original)
})

test('content with newlines, quotes and embedded JSON survives verbatim', async () => {
  seedMonths(cacheDir, [{ month: '2026-06', rows: 5 }])
  await exportMonth({ cacheDir, archiveDir, month: '2026-06' })

  const db = new Database(join(cacheDir, 'store.db'), { readonly: true })
  const sample = db.query('SELECT content FROM transcript_entries WHERE id = 1').get() as { content: string }
  db.close()

  // The fixture deliberately packs the shapes that break CSV.
  expect(sample.content).toContain('\n')
  expect(sample.content).toContain('"quoted, with a comma"')
  expect(sample.content).toContain('{"nested"')
  expect(sample.content).toContain('\\')
  expect(sample.content).toContain('☃')

  const wipe = new Database(join(cacheDir, 'store.db'))
  wipe.run('DELETE FROM transcript_entries')
  wipe.close()
  await importMonth({ archiveDir, month: '2026-06', cacheDir })

  const back = new Database(join(cacheDir, 'store.db'), { readonly: true })
  const restored = back.query('SELECT content FROM transcript_entries WHERE id = 1').get() as { content: string }
  back.close()
  expect(restored.content).toBe(sample.content)
})

test('import is idempotent', async () => {
  seedMonths(cacheDir, [{ month: '2026-06', rows: 40 }])
  await exportMonth({ cacheDir, archiveDir, month: '2026-06' })

  const first = await importMonth({ archiveDir, month: '2026-06', cacheDir })
  expect(first.inserted).toBe(0) // rows are all still present
  expect(first.skipped).toBe(40)
  expect(countRows(cacheDir)).toBe(40)
})

test('verify detects a corrupted archive', async () => {
  seedMonths(cacheDir, [{ month: '2026-06', rows: 30 }])
  await exportMonth({ cacheDir, archiveDir, month: '2026-06' })

  // Flip the recorded hash: stands in for any bit-rot between the meta and
  // the bytes on disk.
  const metaPath = join(archiveDir, metaName('2026-06'))
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
  meta.plaintextSha256 = 'deadbeef'.repeat(8)
  writeFileSync(metaPath, JSON.stringify(meta))

  const verdict = await verifyArchive(archiveDir, '2026-06')
  expect(verdict.ok).toBe(false)
  expect(verdict.problems.join(' ')).toContain('sha256 mismatch')
})

test('verify against the database fails when the database has drifted', async () => {
  seedMonths(cacheDir, [{ month: '2026-06', rows: 30 }])
  await exportMonth({ cacheDir, archiveDir, month: '2026-06' })

  // A late row lands in an already-archived month.
  const db = new Database(join(cacheDir, 'store.db'))
  db.run(
    `INSERT INTO transcript_entries
     (conversation_id, seq, sync_epoch, type, uuid, content, timestamp, ingested_at)
     VALUES ('conv_late', 999, 'e', 'user', 'late-uuid', 'late arrival', ?, ?)`,
    [Date.UTC(2026, 5, 20), Date.UTC(2026, 5, 20)],
  )
  db.close()

  const verdict = await verifyArchive(archiveDir, '2026-06', { cacheDir })
  expect(verdict.ok).toBe(false)
  expect(verdict.matchedDatabase).toBe(false)
  expect(verdict.problems.join(' ')).toContain('re-export before deleting')
})

test('export refuses to overwrite without force', async () => {
  seedMonths(cacheDir, [{ month: '2026-06', rows: 5 }])
  await exportMonth({ cacheDir, archiveDir, month: '2026-06' })
  await expect(exportMonth({ cacheDir, archiveDir, month: '2026-06' })).rejects.toThrow('already exists')
  await expect(exportMonth({ cacheDir, archiveDir, month: '2026-06', force: true })).resolves.toBeTruthy()
})

test('export only takes rows inside the UTC month', async () => {
  seedMonths(cacheDir, [
    { month: '2026-05', rows: 10 },
    { month: '2026-06', rows: 20 },
    { month: '2026-07', rows: 30 },
  ])
  const meta = await exportMonth({ cacheDir, archiveDir, month: '2026-06' })
  expect(meta.rows).toBe(20)
  expect(meta.minTs).toBeGreaterThanOrEqual(Date.UTC(2026, 5, 1))
  expect(meta.maxTs).toBeLessThan(Date.UTC(2026, 6, 1))
})
