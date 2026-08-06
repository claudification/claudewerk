import { ARCHIVE_EXT, ARCHIVE_PREFIX, META_EXT } from './types'

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/

function assertMonth(month: string): void {
  const m = month.match(MONTH_PATTERN)
  if (!m) throw new Error(`Invalid month: "${month}" (expected YYYY-MM)`)
  const mm = parseInt(m[2], 10)
  if (mm < 1 || mm > 12) throw new Error(`Invalid month: "${month}" (month must be 01-12)`)
}

/** Half-open UTC epoch-ms range [start, end) for a `YYYY-MM` key. */
export function monthRange(month: string): { start: number; end: number } {
  assertMonth(month)
  const [y, m] = month.split('-').map(n => parseInt(n, 10))
  return { start: Date.UTC(y, m - 1, 1), end: Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) }
}

/** UTC `YYYY-MM` for an epoch-ms instant. */
export function monthOf(epochMs: number): string {
  const d = new Date(epochMs)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Every month key from `first` to `last` inclusive. */
export function monthsBetween(firstEpochMs: number, lastEpochMs: number): string[] {
  const out: string[] = []
  const d = new Date(Date.UTC(new Date(firstEpochMs).getUTCFullYear(), new Date(firstEpochMs).getUTCMonth(), 1))
  const endKey = monthOf(lastEpochMs)
  for (;;) {
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    out.push(key)
    if (key === endKey) break
    d.setUTCMonth(d.getUTCMonth() + 1)
    if (out.length > 1200) break // 100 years of runaway guard
  }
  return out
}

export function archiveName(month: string): string {
  assertMonth(month)
  return `${ARCHIVE_PREFIX}${month}${ARCHIVE_EXT}`
}

export function metaName(month: string): string {
  assertMonth(month)
  return `${ARCHIVE_PREFIX}${month}${META_EXT}`
}
