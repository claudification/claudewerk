/**
 * Formatting for the vacuum panel.
 *
 * `bytes()` returns a placeholder rather than "0 B" when nothing has been
 * measured. On a destructive dialog those two readings mean opposite things --
 * "there is nothing here" versus "I have not looked" -- and rendering the
 * second as the first is how someone concludes there is nothing to reclaim
 * from a 10 GB database.
 */

import type { BytesMeasurement, VacuumEstimate } from './vacuum-types'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(n: number): string {
  if (n <= 0) return '0 B'
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const value = n / 1024 ** i
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${UNITS[i]}`
}

/** Bytes, or an explicit "not measured" when the byte pass has never run. */
export function formatMeasuredBytes(n: number, bytes: BytesMeasurement): string {
  return bytes.provenance === 'unmeasured' ? '--' : formatBytes(n)
}

export function formatRows(n: number): string {
  return n.toLocaleString()
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`
  const mins = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest === 0 ? `${mins}m` : `${mins}m ${rest}s`
}

/** How old the byte figures are, in words, for the line under the totals. */
export function describeBytes(bytes: BytesMeasurement): string {
  if (bytes.provenance === 'unmeasured') return 'Byte sizes not measured yet'
  if (bytes.provenance === 'measured') return 'Byte sizes measured just now'
  if (bytes.ageSeconds < 90) return 'Byte sizes measured moments ago'
  if (bytes.ageSeconds < 3600) return `Byte sizes measured ${Math.round(bytes.ageSeconds / 60)} min ago`
  const hours = Math.round(bytes.ageSeconds / 3600)
  return `Byte sizes measured ${hours} hour${hours === 1 ? '' : 's'} ago`
}

/** The months a run would actually archive and delete, in order. */
export function eligibleMonths(estimate: VacuumEstimate): string[] {
  return estimate.months.filter(m => m.eligible).map(m => m.month)
}

export function eligibleTotals(estimate: VacuumEstimate): { rows: number; bytes: number } {
  return estimate.months
    .filter(m => m.eligible)
    .reduce((acc, m) => ({ rows: acc.rows + m.rows, bytes: acc.bytes + m.contentBytes }), { rows: 0, bytes: 0 })
}
