import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countRows, makeStoreDb, seedMonths } from '../../archive/__tests__/fixture'
import { sha256File } from '../../backup/hash'
import { writeSuccessSentinel } from '../../backup/sentinel'
import { runMaintenance } from '../run'
import type { MaintenanceOptions } from '../types'

let root: string
let cacheDir: string
let archiveDir: string
let backupDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maint-'))
  cacheDir = join(root, 'cache')
  archiveDir = join(root, 'archives')
  backupDir = join(root, 'backups')
  mkdirSync(backupDir, { recursive: true })
  makeStoreDb(cacheDir)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function seedFreshBackup(ageMinutes = 5): void {
  const name = 'backup-20260807-050000.tar.zst'
  const path = join(backupDir, name)
  writeFileSync(path, 'pretend archive bytes')
  writeSuccessSentinel(backupDir, {
    timestamp: new Date().toISOString(),
    epochMs: Date.now() - ageMinutes * 60_000,
    archive: name,
    sizeBytes: 21,
    sha256: sha256File(path),
    durationMs: 100,
    brokerVersion: 'test',
  })
}

function opts(over: Partial<MaintenanceOptions> = {}): MaintenanceOptions {
  return { cacheDir, backupDir, archiveDir, hotDays: 90, maxBackupAgeMinutes: 90, ...over }
}

function step(report: Awaited<ReturnType<typeof runMaintenance>>, name: string) {
  return report.steps.find(s => s.step === name || s.step.startsWith(`${name}:`))
}

// The whole safety design in one test: no verified backup means nothing else
// even gets a chance to run.
test('ABORTS before touching anything when the backup gate fails', async () => {
  seedMonths(cacheDir, [{ month: '2026-01', rows: 20 }])
  const report = await runMaintenance(opts({ confirmDelete: true }))

  expect(report.ok).toBe(false)
  expect(report.aborted).toBe(true)
  expect(report.abortReason).toContain('has a backup ever succeeded')
  expect(step(report, 'gate:backup')?.status).toBe('failed')
  expect(step(report, 'archive')?.status).toBe('skipped')
  expect(report.rowsDeleted).toBe(0)
  expect(countRows(cacheDir)).toBe(20)
})

test('archives and verifies but does NOT delete without confirmDelete', async () => {
  seedFreshBackup()
  seedMonths(cacheDir, [
    { month: '2026-01', rows: 20 },
    { month: '2026-08', rows: 5 },
  ])

  const report = await runMaintenance(opts())

  expect(step(report, 'gate:backup')?.status).toBe('ok')
  expect(report.monthsArchived).toEqual(['2026-01'])
  expect(step(report, 'delete')?.status).toBe('skipped')
  expect(step(report, 'delete')?.detail).toContain('archives written, rows kept')
  expect(report.rowsDeleted).toBe(0)
  expect(countRows(cacheDir)).toBe(25)
  expect(report.ok).toBe(true)
})

test('deletes archived months when confirmDelete is set, and smoketests clean', async () => {
  seedFreshBackup()
  seedMonths(cacheDir, [
    { month: '2026-01', rows: 20 },
    { month: '2026-08', rows: 5 },
  ])

  const report = await runMaintenance(opts({ confirmDelete: true }))

  expect(report.monthsArchived).toEqual(['2026-01'])
  expect(report.rowsDeleted).toBe(20)
  expect(countRows(cacheDir)).toBe(5)
  expect(step(report, 'checkpoint')?.status).toBe('ok')
  expect(step(report, 'smoketest')?.status).toBe('ok')
  expect(step(report, 'smoketest')?.detail).toContain('PASS quick_check')
  expect(report.ok).toBe(true)
})

test('dry run writes archives but skips every mutating step', async () => {
  seedFreshBackup()
  seedMonths(cacheDir, [{ month: '2026-01', rows: 12 }])

  const report = await runMaintenance(opts({ dryRun: true, confirmDelete: true }))

  expect(report.monthsArchived).toEqual(['2026-01'])
  for (const name of ['delete', 'checkpoint', 'vacuum']) {
    expect(step(report, name)?.status).toBe('skipped')
  }
  expect(countRows(cacheDir)).toBe(12)
})

test('leaves everything alone when no month is old enough', async () => {
  seedFreshBackup()
  seedMonths(cacheDir, [{ month: '2026-08', rows: 9 }])

  const report = await runMaintenance(opts())

  expect(report.monthsArchived).toEqual([])
  expect(step(report, 'archive')?.status).toBe('skipped')
  expect(step(report, 'archive')?.detail).toContain('no months older than 90 days')
  expect(countRows(cacheDir)).toBe(9)
  expect(report.ok).toBe(true)
})

test('a stale backup fails the gate even though a sentinel exists', async () => {
  seedFreshBackup(60 * 24) // a day old
  seedMonths(cacheDir, [{ month: '2026-01', rows: 10 }])

  const report = await runMaintenance(opts({ maxBackupAgeMinutes: 90, confirmDelete: true }))

  expect(report.ok).toBe(false)
  expect(report.abortReason).toContain('max 90m')
  expect(countRows(cacheDir)).toBe(10)
})

test('writes a machine-readable report next to the backups', async () => {
  seedFreshBackup()
  seedMonths(cacheDir, [{ month: '2026-08', rows: 3 }])
  await runMaintenance(opts())

  const written = JSON.parse(await Bun.file(join(backupDir, '.last-maintenance.json')).text())
  expect(written.ok).toBe(true)
  expect(Array.isArray(written.steps)).toBe(true)
  expect(written.rowsBefore).toBe(3)
})
