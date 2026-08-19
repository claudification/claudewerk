import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { archivePhase, deletePhase, gatePhase, reclaimPhase, smoketestPhase } from './phases'
import { Runner } from './runner'
import { dbSizeBytes, transcriptRowCount } from './steps'
import { MAINTENANCE_REPORT, type MaintenanceOptions, type MaintenanceReport } from './types'

/** The nightly job.
 *
 *  Ordering is the entire safety design:
 *
 *    GATE -> ARCHIVE -> VERIFY -> DELETE -> CHECKPOINT -> VACUUM -> SMOKETEST
 *
 *  Nothing destructive happens before a verified backup exists AND the archive
 *  covering those rows has been checked against the live database. If any of
 *  that fails the run stops where it is and the database is exactly as it was. */
export async function runMaintenance(opts: MaintenanceOptions): Promise<MaintenanceReport> {
  const startedAt = new Date()
  const r = new Runner()
  const rowsBefore = transcriptRowCount(opts.cacheDir)
  const dbBytesBefore = dbSizeBytes(opts.cacheDir)

  await gatePhase(r, opts)
  const monthsArchived = await archivePhase(r, opts)
  const rowsDeleted = await deletePhase(r, opts, monthsArchived)
  await reclaimPhase(r, opts, rowsDeleted)

  const rowsAfter = transcriptRowCount(opts.cacheDir)
  await smoketestPhase(r, opts, { rowsAfter, minRows: Math.max(0, rowsBefore - rowsDeleted) })

  const finishedAt = new Date()
  const report: MaintenanceReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ok: !r.aborted,
    aborted: r.aborted,
    abortReason: r.abortReason,
    steps: r.steps,
    rowsBefore,
    rowsAfter,
    rowsDeleted,
    monthsArchived,
    dbBytesBefore,
    dbBytesAfter: dbSizeBytes(opts.cacheDir),
  }

  writeFileSync(join(opts.backupDir, MAINTENANCE_REPORT), `${JSON.stringify(report, null, 2)}\n`)
  return report
}
