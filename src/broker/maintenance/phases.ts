import { statSync } from 'node:fs'
import { exportMonth, monthsToArchive, pruneArchivedMonth, verifyArchive } from '../archive'
import { checkBackupGate } from '../backup'
import type { Runner } from './runner'
import { runSmoketest } from './smoketest'
import { checkpointWal, freeSpaceBytes, storeDbPath, vacuumDatabase } from './steps'
import type { MaintenanceOptions } from './types'

function fmtGb(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** A verified, recent backup is the rollback for everything that follows.
 *  Nothing destructive gets a chance to run if this fails. */
export async function gatePhase(r: Runner, opts: MaintenanceOptions): Promise<void> {
  await r.step('gate:backup', () => {
    const verdict = checkBackupGate(opts.backupDir, opts.maxBackupAgeMinutes)
    if (!verdict.ok) throw new Error(verdict.reason)
    return verdict.reason
  })
}

/** Export + verify each aged-out month. A month that fails to verify stays in
 *  the hot database; it is not a reason to abandon the other months. */
export async function archivePhase(r: Runner, opts: MaintenanceOptions): Promise<string[]> {
  const candidates = r.aborted ? [] : monthsToArchive(opts.cacheDir, opts.hotDays)
  if (candidates.length === 0) {
    r.skip('archive', r.aborted ? 'run aborted at the gate' : `no months older than ${opts.hotDays} days`)
    return []
  }

  const verified: string[] = []
  for (const month of candidates) {
    const ok = await r.step(`archive:${month}`, async () => {
      const meta = await exportMonth({ cacheDir: opts.cacheDir, archiveDir: opts.archiveDir, month, force: true })
      const verdict = await verifyArchive(opts.archiveDir, month, { cacheDir: opts.cacheDir })
      if (!verdict.ok) throw new Error(`verify failed: ${verdict.problems.join('; ')}`)
      return `${meta.rows.toLocaleString()} rows, ${(meta.compressedBytes / 1024 / 1024).toFixed(1)} MB, verified`
    })
    if (ok) verified.push(month)
  }
  return verified
}

/** The irreversible step, gated twice: opts.confirmDelete here, plus
 *  pruneArchivedMonth's own re-verification and row-count rollback. */
export async function deletePhase(r: Runner, opts: MaintenanceOptions, verified: string[]): Promise<number> {
  if (opts.dryRun || !opts.confirmDelete) {
    r.skip('delete', opts.dryRun ? 'dry run' : 'confirmDelete not set -- archives written, rows kept')
    return 0
  }

  let rowsDeleted = 0
  for (const month of verified) {
    await r.step(`delete:${month}`, async () => {
      const res = await pruneArchivedMonth({
        cacheDir: opts.cacheDir,
        archiveDir: opts.archiveDir,
        month,
        confirm: true,
      })
      if (!res.applied) throw new Error(res.reason)
      rowsDeleted += res.deleted
      return res.reason
    })
  }
  return rowsDeleted
}

/** Fold the WAL back in, then reclaim the pages the delete freed. */
export async function reclaimPhase(r: Runner, opts: MaintenanceOptions): Promise<void> {
  if (opts.dryRun) {
    r.skip('checkpoint', 'dry run')
  } else {
    await r.step('checkpoint', () => checkpointWal(opts.cacheDir))
  }

  if (opts.dryRun || opts.skipVacuum) {
    r.skip('vacuum', opts.dryRun ? 'dry run' : 'skipVacuum set')
    return
  }

  // VACUUM builds a complete second copy before swapping, so it needs free
  // space roughly equal to the database. Running out mid-VACUUM is recoverable
  // but wastes the whole nightly window.
  const needed = statSync(storeDbPath(opts.cacheDir)).size
  const free = freeSpaceBytes(opts.cacheDir)
  if (free < needed * 1.1) {
    r.skip('vacuum', `insufficient free space (need ~${fmtGb(needed)}, have ${fmtGb(free)})`)
    return
  }
  await r.step('vacuum', () => vacuumDatabase(opts.cacheDir))
}

/** Always runs, even after an abort, so the report says whether the database is
 *  healthy right now rather than only how far the run got. */
export async function smoketestPhase(
  r: Runner,
  opts: MaintenanceOptions,
  expected: { rowsAfter: number; minRows: number },
): Promise<void> {
  const checks = await runSmoketest(opts.cacheDir, expected, opts.healthUrl)
  const failed = checks.filter(c => !c.ok)
  r.record(
    'smoketest',
    failed.length === 0 ? 'ok' : 'failed',
    checks.map(c => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`).join(' | '),
  )
  if (failed.length > 0) r.abort(`smoketest failed: ${failed.map(c => c.name).join(', ')}`)
}
