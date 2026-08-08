import type { ArchiveSearchHit, ArchiveSearchResult } from '../archive/search'
import type { ArchiveSearchPlan } from '../archive/search-plan'

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function stamp(ms: number): string {
  return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '-'
}

export function renderSearchPlan(plan: ArchiveSearchPlan): void {
  if (plan.months.length === 0) {
    console.log('No archives in scope -- nothing to search.')
    return
  }
  console.log(`\n  Cold search plan (${plan.months.length} month(s)):\n`)
  console.log(`  ${'MONTH'.padEnd(9)} ${'ROWS'.padStart(12)} ${'PLAINTEXT'.padStart(12)} ${'ON DISK'.padStart(12)}`)
  console.log(`  ${'-'.repeat(9)} ${'-'.repeat(12)} ${'-'.repeat(12)} ${'-'.repeat(12)}`)
  for (const m of plan.months) {
    console.log(
      `  ${m.month.padEnd(9)} ${m.rows.toLocaleString().padStart(12)} ${mb(m.plaintextBytes).padStart(12)} ${mb(m.compressedBytes).padStart(12)}`,
    )
  }
  console.log(
    `\n  ${plan.totalRows.toLocaleString()} rows, ${mb(plan.totalPlaintextBytes)} to decompress and scan` +
      ` -- roughly ${plan.estimatedSeconds}s.`,
  )
  if (plan.unmeasuredMonths.length > 0) {
    console.log(`  NOTE: no meta for ${plan.unmeasuredMonths.join(', ')} -- the estimate is a floor, not a total.`)
  }
  console.log()
}

function renderHit(hit: ArchiveSearchHit): void {
  const type = `${hit.type}${hit.subtype ? `/${hit.subtype}` : ''}`
  console.log(`\n  ${hit.month}  ${hit.conversationId}  seq ${hit.seq}  ${type}  ${stamp(hit.timestamp)}`)
  console.log(`    ${hit.snippet}`)
}

const TRUNCATION_REASONS: Record<string, string> = {
  limit: 'hit the result limit',
  time: 'ran out of time budget',
}

/** What was read, and -- the part that matters -- what was not. */
export function coverageLine(result: ArchiveSearchResult): string {
  const scanned = result.scannedMonths.length > 0 ? result.scannedMonths.join(', ') : 'nothing'
  const needle = result.regex ? `regex ${result.query}` : `"${result.query}"`
  return (
    `${result.hits.length} hit(s) for ${needle} -- scanned ${scanned}` +
    ` (${result.rowsScanned.toLocaleString()} rows, ${mb(result.bytesScanned)})` +
    ` in ${(result.elapsedMs / 1000).toFixed(1)}s`
  )
}

/** Empty when the answer is complete. */
export function truncationLine(result: ArchiveSearchResult): string {
  if (!result.truncated) return ''
  const why = TRUNCATION_REASONS[result.truncatedReason] ?? 'stopped early'
  const missed = result.skippedMonths.join(', ') || '(rest of the last month)'
  return `INCOMPLETE: ${why}. NOT searched: ${missed}`
}

/** Always prints the coverage line, hits or not. A cold search that shows
 *  results without showing what it skipped is telling a half-truth. */
export function renderSearchResult(result: ArchiveSearchResult): void {
  for (const hit of result.hits) renderHit(hit)
  console.log(`\n  ${coverageLine(result)}`)
  const truncation = truncationLine(result)
  if (truncation) console.log(`  ${truncation}`)
  console.log()
}
