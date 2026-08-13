/**
 * Assembles the one object the vacuum dialog renders.
 *
 * The rule this module exists to keep: every number is measured at open time
 * against the live database, and anything derived is named `projected*` with
 * its derivation written down. A wrong estimate on a destructive dialog is
 * worse than no estimate.
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { listArchives, monthsToArchive } from '../archive'
import { checkBackupGate } from '../backup'
import { freeSpaceBytes } from '../maintenance/steps'
import { openBrokerDatabase } from '../sqlite-open'
import { findRedundantIndexes, measureFootprint, measureMonths, measureOrphans } from './measure-db'
import { measureFileSweeps, measureOrphanedScenes } from './measure-files'
import type { DbFootprint, GateVerdict, MonthEstimate, VacuumEstimate, VacuumPlan } from './types'

export interface EstimateOptions {
  cacheDir: string
  backupDir: string
  archiveDir: string
  hotDays: number
  /** Per-row age overrides for the file sweeps, keyed by sweep key. */
  fileAges?: Record<string, number>
  maxBackupAgeMinutes?: number
  now?: number
}

/** Matches the nightly job's default so the dialog and the cron agree on what
 *  "a recent backup" means. */
const DEFAULT_MAX_BACKUP_AGE_MINUTES = 90

function gateVerdict(backupDir: string, maxAgeMinutes: number, now: number): GateVerdict {
  const verdict = checkBackupGate(backupDir, maxAgeMinutes, now)
  const ageMinutes = verdict.sentinel ? Math.round((now - verdict.sentinel.epochMs) / 60_000) : -1
  return {
    ok: verdict.ok,
    reason: verdict.reason,
    backupArchive: verdict.sentinel?.archive ?? '',
    backupAgeMinutes: ageMinutes,
  }
}

/** What deleting a set of transcript rows actually returns to the filesystem.
 *
 *  Three components, because they scale on different things:
 *    - content   -- counted exactly, it IS the deleted bytes
 *    - FTS index -- scales with the volume of indexed TEXT, so it is
 *                   apportioned by content share
 *    - everything else (per-row overhead, the nine indexes on
 *      transcript_entries, other tables) -- scales with ROW COUNT, so it is
 *      apportioned by row share
 *
 *  Both shares are proportional models, not measurements: without dbstat there
 *  is no way to read a table's true page count. The dry-run reports the real
 *  number, and the dialog labels this an estimate. */
function projectReclaim(footprint: DbFootprint, rows: number, contentBytes: number): number {
  if (footprint.totalRows === 0 || rows === 0) return 0
  const contentShare = footprint.contentBytes > 0 ? contentBytes / footprint.contentBytes : 0
  const rowShare = rows / footprint.totalRows
  return Math.round(contentBytes + footprint.ftsIndexBytes * contentShare + footprint.otherBytes * rowShare)
}

/** Measured on this database via the backup pipeline: a VACUUM INTO of 8.66 GB
 *  ran inside a 214 s backup whose other steps (compress, read-back verify)
 *  dominate. ~70 MB/s is the conservative read of that, and the panel shows the
 *  number as a range rather than a promise. */
const VACUUM_BYTES_PER_SECOND = 70 * 1024 * 1024

function vacuumPlan(footprint: DbFootprint, cacheDir: string, reclaimBytes: number): VacuumPlan {
  const remaining = Math.max(0, footprint.fileBytes - reclaimBytes)
  const free = freeSpaceBytes(cacheDir)
  return {
    freeBytes: free,
    neededBytes: footprint.fileBytes,
    hasHeadroom: free > footprint.fileBytes * 1.1,
    estimatedLockSeconds: Math.round(remaining / VACUUM_BYTES_PER_SECOND),
    // 0 = NONE, 1 = FULL, 2 = INCREMENTAL. Flipping to INCREMENTAL requires a
    // full VACUUM anyway, so we pay that rewrite exactly once, here.
    willEnableIncremental: footprint.autoVacuum !== 2,
  }
}

function fileBytesOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

export function measureVacuum(opts: EstimateOptions): VacuumEstimate {
  const started = Date.now()
  const now = opts.now ?? started
  const dbPath = join(opts.cacheDir, 'store.db')

  const eligibleMonths = monthsToArchive(opts.cacheDir, opts.hotDays, now)
  const archivedMonths = new Set(listArchives(opts.archiveDir).map(a => a.month))

  const db = openBrokerDatabase(dbPath, { readonly: true })
  let months: MonthEstimate[]
  let footprint: DbFootprint
  let orphans: ReturnType<typeof measureOrphans>
  let redundantIndexes: ReturnType<typeof findRedundantIndexes>
  try {
    footprint = measureFootprint(db, fileBytesOf(dbPath), fileBytesOf(`${dbPath}-wal`))
    months = measureMonths(db, new Set(eligibleMonths), archivedMonths)
    orphans = measureOrphans(db, new Set(eligibleMonths))
    redundantIndexes = findRedundantIndexes(db, 'transcript_entries')
  } finally {
    db.close()
  }

  const canvasDbPath = join(opts.cacheDir, 'canvases.db')
  const canvasDb = existsSync(canvasDbPath) ? openBrokerDatabase(canvasDbPath, { readonly: true }) : null
  let fileSweeps: VacuumEstimate['fileSweeps']
  try {
    fileSweeps = [
      ...measureFileSweeps(opts.cacheDir, opts.fileAges, now),
      measureOrphanedScenes(opts.cacheDir, canvasDb),
    ]
  } finally {
    canvasDb?.close()
  }

  const selected = months.filter(m => m.eligible)
  const projectedTranscriptBytes = projectReclaim(
    footprint,
    selected.reduce((s, m) => s + m.rows, 0),
    selected.reduce((s, m) => s + m.contentBytes, 0),
  )
  const orphanBytes = projectReclaim(footprint, orphans.sweepableRows, orphans.sweepableBytes)
  const indexBytes = redundantIndexes.reduce((s, i) => s + i.projectedBytes, 0)
  const fileBytes = fileSweeps.reduce((s, f) => s + f.matchedBytes, 0)

  const projectedTotalBytes = projectedTranscriptBytes + orphanBytes + indexBytes + fileBytes
  const dbReclaim = projectedTranscriptBytes + orphanBytes + indexBytes

  return {
    measuredAt: new Date(now).toISOString(),
    measureDurationMs: Date.now() - started,
    hotDays: opts.hotDays,
    gate: gateVerdict(opts.backupDir, opts.maxBackupAgeMinutes ?? DEFAULT_MAX_BACKUP_AGE_MINUTES, now),
    footprint,
    months,
    orphans,
    redundantIndexes,
    fileSweeps,
    projectedTranscriptBytes,
    projectedTotalBytes,
    projectedDbBytesAfter: Math.max(0, footprint.fileBytes - dbReclaim),
    vacuum: vacuumPlan(footprint, opts.cacheDir, dbReclaim),
  }
}
