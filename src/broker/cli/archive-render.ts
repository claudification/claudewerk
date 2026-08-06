import type { Coverage, CoverageMonth } from '../archive/list'
import type { VerifyResult } from '../archive/types'

/** hot/cold state label, keyed on the two booleans that decide it. */
const STATE_LABELS: Record<string, string> = {
  'true|true': 'hot + archived',
  'true|false': 'hot only',
  'false|true': 'archived',
  'false|false': 'GAP',
}

function describeState(m: CoverageMonth): string {
  return STATE_LABELS[`${m.hotRows > 0}|${m.archived}`]
}

export function renderCoverage(coverage: Coverage, archiveDir: string): void {
  if (coverage.months.length === 0) {
    console.log(`No transcript data and no archives in ${archiveDir}`)
    return
  }

  console.log(`\n  Transcript coverage (archives in ${archiveDir}):\n`)
  console.log(`  ${'MONTH'.padEnd(9)} ${'HOT'.padStart(12)} ${'COLD'.padStart(12)}  STATE`)
  console.log(`  ${'-'.repeat(9)} ${'-'.repeat(12)} ${'-'.repeat(12)}  ${'-'.repeat(18)}`)

  for (const m of coverage.months) {
    const hot = m.hotRows > 0 ? m.hotRows.toLocaleString() : '-'
    const cold = m.coldRows !== null ? m.coldRows.toLocaleString() : '-'
    console.log(`  ${m.month.padEnd(9)} ${hot.padStart(12)} ${cold.padStart(12)}  ${describeState(m)}`)
  }

  console.log(`\n  ${coverage.hotRows.toLocaleString()} rows hot, ${coverage.coldRows.toLocaleString()} rows cold`)
  if (coverage.gaps.length > 0) console.log(`  GAPS (no data, no archive): ${coverage.gaps.join(', ')}`)
  console.log()
}

export function renderVerify(result: VerifyResult): void {
  console.log(`${result.ok ? 'OK' : 'FAILED'}: ${result.month} (${result.rows.toLocaleString()} rows)`)
  if (result.matchedDatabase !== undefined) {
    console.log(`  database match: ${result.matchedDatabase ? 'yes' : 'NO'}`)
  }
  for (const p of result.problems) console.log(`  - ${p}`)
}
