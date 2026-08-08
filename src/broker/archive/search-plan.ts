/** What a cold search is about to cost, without paying it.
 *
 *  Every archive ships a `.meta.json` carrying the exact uncompressed byte count
 *  and row count of its month, so the size of the job is known before a single
 *  byte is decompressed. Both the CLI (`--plan`) and the MCP tool lead with this
 *  so nobody kicks off a ten-minute scan by accident.
 */

import { listArchives } from './list'

/** Measured on this box: decompress + line-split + substring test, end to end,
 *  over real transcript text. Deliberately conservative -- an estimate that runs
 *  under is worse than one that runs over. */
const SCAN_PLAINTEXT_BYTES_PER_SEC = 220 * 1024 * 1024

export interface PlannedMonth {
  month: string
  compressedBytes: number
  plaintextBytes: number
  rows: number
}

export interface ArchiveSearchPlan {
  months: PlannedMonth[]
  totalCompressedBytes: number
  totalPlaintextBytes: number
  totalRows: number
  /** Wall-clock guess for scanning every month in scope. */
  estimatedSeconds: number
  /** Months in scope whose meta is missing, so their cost is unknown and the
   *  estimate is a floor rather than a total. */
  unmeasuredMonths: string[]
}

export function planArchiveSearch(archiveDir: string, wanted?: string[]): ArchiveSearchPlan {
  const available = listArchives(archiveDir)
  const scope = wanted?.length ? available.filter(a => wanted.includes(a.month)) : available

  const months: PlannedMonth[] = scope
    .map(a => ({
      month: a.month,
      compressedBytes: a.compressedBytes,
      plaintextBytes: a.meta?.plaintextBytes ?? 0,
      rows: a.meta?.rows ?? 0,
    }))
    .sort((a, b) => b.month.localeCompare(a.month))

  const totalPlaintextBytes = months.reduce((s, m) => s + m.plaintextBytes, 0)
  return {
    months,
    totalCompressedBytes: months.reduce((s, m) => s + m.compressedBytes, 0),
    totalPlaintextBytes,
    totalRows: months.reduce((s, m) => s + m.rows, 0),
    estimatedSeconds: Math.round((totalPlaintextBytes / SCAN_PLAINTEXT_BYTES_PER_SEC) * 10) / 10,
    unmeasuredMonths: scope.filter(a => !a.meta).map(a => a.month),
  }
}
