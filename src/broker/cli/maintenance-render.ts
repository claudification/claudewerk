import type { MaintenanceReport, StepStatus } from '../maintenance/types'

const STATUS_MARK: Record<StepStatus, string> = { ok: 'PASS', skipped: 'SKIP', failed: 'FAIL' }

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

export function renderReport(report: MaintenanceReport): void {
  console.log(`\n  Maintenance ${report.ok ? 'OK' : 'FAILED'} in ${(report.durationMs / 1000).toFixed(1)}s\n`)

  for (const s of report.steps) {
    const dur = s.durationMs > 0 ? ` (${(s.durationMs / 1000).toFixed(1)}s)` : ''
    console.log(`  ${STATUS_MARK[s.status]} ${s.step}${dur}`)
    console.log(`       ${s.detail}`)
  }

  console.log()
  console.log(`  Rows:    ${report.rowsBefore.toLocaleString()} -> ${report.rowsAfter.toLocaleString()}`)
  console.log(`  Deleted: ${report.rowsDeleted.toLocaleString()}`)
  console.log(`  DB:      ${mb(report.dbBytesBefore)} -> ${mb(report.dbBytesAfter)}`)
  if (report.monthsArchived.length > 0) console.log(`  Archived: ${report.monthsArchived.join(', ')}`)
  if (report.aborted) console.log(`\n  ABORTED: ${report.abortReason}`)
  console.log()
}
