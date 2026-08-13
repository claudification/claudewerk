/**
 * The vacuum run: drive the EXISTING nightly pipeline, then the derived-data
 * sweeps, broadcasting each step as it completes.
 *
 * This deliberately owns no delete logic of its own. Transcript rows go through
 * `runMaintenance` -- the same gate -> archive -> verify -> delete -> checkpoint
 * -> vacuum -> smoketest the cron has always driven -- so there is exactly one
 * code path that can remove a transcript row, and it is the one with the
 * archive verification and the transactional row-count rollback behind it.
 *
 * What this adds is the policy layer the cron never had: a chosen hotDays, a
 * visible gate, per-step broadcasts, and the derived sweeps.
 */

import type { VacuumStepMessage } from '../../shared/protocol'
import { runMaintenance } from '../maintenance'
import { dbSizeBytes, transcriptRowCount } from '../maintenance/steps'
import type { MaintenanceReport } from '../maintenance/types'
import { measureVacuum } from './estimate'
import { dropRedundantIndexes, type SweepOutcome, sweepFiles } from './sweep'
import type { VacuumEstimate } from './types'

export interface VacuumCategories {
  transcripts: boolean
  indexes: boolean
  /** Sweep key -> age threshold in days. Absent key = not selected. */
  files: Record<string, number | undefined>
}

export interface VacuumRunOptions {
  cacheDir: string
  backupDir: string
  archiveDir: string
  hotDays: number
  /** Nothing is deleted unless this is true. Mirrors `maintain --confirm`. */
  confirm: boolean
  /** Auth principal, recorded on every broadcast step. */
  initiator: string
  runId: string
  categories: VacuumCategories
  emit: (msg: VacuumStepMessage) => void
  now?: number
}

export interface VacuumRunResult {
  runId: string
  dryRun: boolean
  maintenance: MaintenanceReport | null
  sweeps: SweepOutcome[]
  rowsBefore: number
  rowsAfter: number
  dbBytesBefore: number
  dbBytesAfter: number
  bytesReclaimed: number
}

type Emit = (step: string, status: VacuumStepMessage['status'], detail: string) => void

/** Every step carries the counts and bytes on both sides of the run, so the
 *  broadcast stream alone is enough to reconstruct what happened (LOG
 *  EVERYTHING). `rowsAfter` / `dbBytesAfter` are re-read per step rather than
 *  captured once, so a step that changed nothing is visibly distinct from one
 *  that did. */
function createEmitter(opts: VacuumRunOptions, rowsBefore: number, dbBytesBefore: number): Emit {
  return (step, status, detail) => {
    opts.emit({
      type: 'vacuum_step',
      runId: opts.runId,
      step,
      status,
      detail,
      rowsBefore,
      rowsAfter: transcriptRowCount(opts.cacheDir),
      dbBytesBefore,
      dbBytesAfter: dbSizeBytes(opts.cacheDir),
      initiator: opts.initiator,
      dryRun: !opts.confirm,
      ts: Date.now(),
    })
  }
}

/** Transcript reclaim, delegated wholesale to the nightly pipeline. */
async function transcriptPhase(opts: VacuumRunOptions, emit: Emit): Promise<MaintenanceReport | null> {
  if (!opts.categories.transcripts) {
    emit('transcripts', 'skipped', 'category not selected')
    return null
  }

  const report = await runMaintenance({
    cacheDir: opts.cacheDir,
    backupDir: opts.backupDir,
    archiveDir: opts.archiveDir,
    hotDays: opts.hotDays,
    maxBackupAgeMinutes: MAX_BACKUP_AGE_MINUTES,
    dryRun: !opts.confirm,
    confirmDelete: opts.confirm,
  })
  for (const step of report.steps) emit(step.step, step.status, step.detail)
  return report
}

/** Derived-data sweeps: indexes SQLite can rebuild, files the broker
 *  regenerates. Neither needs the backup gate. */
function sweepPhase(opts: VacuumRunOptions, estimate: VacuumEstimate, emit: Emit): SweepOutcome[] {
  const outcomes: SweepOutcome[] = []

  if (opts.categories.indexes) {
    for (const outcome of dropRedundantIndexes(opts.cacheDir, estimate.redundantIndexes, opts.confirm)) {
      outcomes.push(outcome)
      emit(`index:${outcome.target}`, outcome.applied ? 'ok' : 'skipped', outcome.detail)
    }
  }

  for (const [key, days] of Object.entries(opts.categories.files)) {
    if (days === undefined) continue
    const found = estimate.fileSweeps.find(f => f.key === key)
    if (!found) {
      emit(`files:${key}`, 'skipped', 'no such sweep on this broker')
      continue
    }
    const outcome = sweepFiles({ estimate: found, days }, opts.confirm, opts.now)
    outcomes.push(outcome)
    emit(`files:${key}`, outcome.applied ? 'ok' : 'skipped', outcome.detail)
  }

  return outcomes
}

const MAX_BACKUP_AGE_MINUTES = 90

export async function runVacuum(opts: VacuumRunOptions): Promise<VacuumRunResult> {
  const rowsBefore = transcriptRowCount(opts.cacheDir)
  const dbBytesBefore = dbSizeBytes(opts.cacheDir)
  const emit = createEmitter(opts, rowsBefore, dbBytesBefore)

  const finish = (maintenance: MaintenanceReport | null, sweeps: SweepOutcome[]): VacuumRunResult => {
    const rowsAfter = transcriptRowCount(opts.cacheDir)
    const dbBytesAfter = dbSizeBytes(opts.cacheDir)
    return {
      runId: opts.runId,
      dryRun: !opts.confirm,
      maintenance,
      sweeps,
      rowsBefore,
      rowsAfter,
      dbBytesBefore,
      dbBytesAfter,
      bytesReclaimed: Math.max(0, dbBytesBefore - dbBytesAfter),
    }
  }

  emit('start', 'started', `hotDays=${opts.hotDays}, confirm=${opts.confirm}`)

  // The gate is reported BEFORE anything runs, and its literal reason goes on
  // the wire. The nightly cron silently skips when it fails; this must not.
  const estimate = measureVacuum({
    cacheDir: opts.cacheDir,
    backupDir: opts.backupDir,
    archiveDir: opts.archiveDir,
    hotDays: opts.hotDays,
    ...(opts.now !== undefined && { now: opts.now }),
  })
  emit('gate', estimate.gate.ok ? 'ok' : 'failed', estimate.gate.reason)

  if (opts.confirm && !estimate.gate.ok) {
    emit('abort', 'failed', `refusing to delete without a verified backup: ${estimate.gate.reason}`)
    return finish(null, [])
  }

  const maintenance = await transcriptPhase(opts, emit)
  const sweeps = sweepPhase(opts, estimate, emit)

  const result = finish(maintenance, sweeps)
  emit('done', 'ok', summarise(result))
  return result
}

function summarise(result: VacuumRunResult): string {
  if (result.dryRun) return 'dry run complete -- nothing was touched'
  const mb = (result.bytesReclaimed / 1024 / 1024).toFixed(0)
  return `${(result.rowsBefore - result.rowsAfter).toLocaleString()} rows removed, ${mb} MB returned to the filesystem`
}
