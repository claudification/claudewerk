import { runMaintenance } from '../maintenance'
import type { MaintenanceOptions } from '../maintenance/types'
import { renderReport } from './maintenance-render'
import type { ParsedArgs } from './parse-args'
import { DEFAULT_ARCHIVE_DIR, DEFAULT_BACKUP_DIR } from './shared'
import { positiveIntArg } from './subcommand'

/** Flags -> options. Split out so it can be asserted directly; the defaults
 *  here (90-day hot window, 90-minute backup freshness) are the safety
 *  posture, not incidental formatting. */
export function maintenanceOptionsFrom(args: ParsedArgs): MaintenanceOptions {
  return {
    cacheDir: args.cacheDir,
    backupDir: args.destArg || DEFAULT_BACKUP_DIR,
    archiveDir: args.archiveDirArg || DEFAULT_ARCHIVE_DIR,
    hotDays: positiveIntArg(args.hotDaysArg, 90, '--hot-days'),
    maxBackupAgeMinutes: positiveIntArg(args.maxBackupAgeArg, 90, '--max-backup-age'),
    dryRun: args.dryRun,
    confirmDelete: args.confirmFlag,
    skipVacuum: args.skipVacuumFlag,
    ...(args.healthUrlArg && { healthUrl: args.healthUrlArg }),
  }
}

export async function handleMaintain(args: ParsedArgs): Promise<void> {
  const report = await runMaintenance(maintenanceOptionsFrom(args))

  if (args.jsonFlag) console.log(JSON.stringify(report, null, 2))
  else renderReport(report)
  process.exit(report.ok ? 0 : 1)
}
