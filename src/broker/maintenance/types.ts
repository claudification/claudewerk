export const MAINTENANCE_REPORT = '.last-maintenance.json'

export interface MaintenanceOptions {
  cacheDir: string
  /** Where `backup create` writes; the gate reads its sentinel from here. */
  backupDir: string
  archiveDir: string
  /** Rows newer than this stay in the hot database. */
  hotDays: number
  /** Refuse to run if the last successful backup is older than this. */
  maxBackupAgeMinutes: number
  /** Export + verify only. No deletes, no VACUUM. */
  dryRun?: boolean
  /** Required before any row is deleted, on top of the archive verification. */
  confirmDelete?: boolean
  /** Skip the VACUUM step (it needs free space equal to the database size). */
  skipVacuum?: boolean
  /** Broker health URL for the smoketest; empty disables that probe. */
  healthUrl?: string
}

export type StepStatus = 'ok' | 'skipped' | 'failed'

export interface StepResult {
  step: string
  status: StepStatus
  detail: string
  durationMs: number
}

export interface MaintenanceReport {
  startedAt: string
  finishedAt: string
  durationMs: number
  ok: boolean
  aborted: boolean
  abortReason: string
  steps: StepResult[]
  rowsBefore: number
  rowsAfter: number
  rowsDeleted: number
  monthsArchived: string[]
  dbBytesBefore: number
  dbBytesAfter: number
}
