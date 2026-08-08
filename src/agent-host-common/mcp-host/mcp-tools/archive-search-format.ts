/** Wire shapes and rendering for the cold-archive tools.
 *
 *  Split from the tool definitions so the descriptions -- which are the entire
 *  mechanism steering an agent away from a needless multi-minute scan -- can be
 *  read and edited without scrolling past the HTTP plumbing.
 */

export interface ArchiveHit {
  month: string
  conversationId: string
  seq: number
  type: string
  subtype: string | null
  timestamp: number
  snippet: string
}

export interface ArchiveSearchResponse {
  query: string
  hits: ArchiveHit[]
  scannedMonths: string[]
  skippedMonths: string[]
  rowsScanned: number
  bytesScanned: number
  elapsedMs: number
  truncated: boolean
  truncatedReason: '' | 'limit' | 'time'
}

export interface ArchivePlanResponse {
  configured: boolean
  months: Array<{ month: string; rows: number; plaintextBytes: number; compressedBytes: number }>
  totalRows: number
  totalPlaintextBytes: number
  estimatedSeconds: number
  unmeasuredMonths: string[]
}

export const SEARCH_DESCRIPTION = [
  'SLOW, EXPENSIVE, LAST RESORT -- a grep over COLD transcript archives.',
  '',
  'Cold archives are whole months of transcript that aged out of the hot database and now live as compressed',
  'NDJSON, one immutable file per month. They have NO INDEX. Searching them decompresses and scans every byte',
  'of every month in scope: seconds for one month, MINUTES for a full history, pinning a CPU core throughout.',
  '',
  'ALWAYS try search_transcripts FIRST -- it is an FTS5 index and answers in milliseconds. Reach for this only',
  'when search_transcripts came back empty AND what you want is older than the hot window (~90 days).',
  'Call archive_search_plan first to see the cost, and pass `month` whenever you can: one month is far',
  'cheaper than the whole archive.',
  '',
  'Matching is literal substring by default (case-insensitive), or a JS regex with regex:true against the',
  'JSON-escaped line. NO stemming and NO ranking -- "run" will not find "running". Newest month first.',
  '',
  'Output always ends with what was scanned and what was skipped. If it says INCOMPLETE, say so in your answer',
  'instead of presenting the hits as the whole picture.',
].join('\n')

export const PLAN_DESCRIPTION =
  "Cost a cold-archive search WITHOUT running it. Cheap: reads each month's meta sidecar, decompresses " +
  'nothing. Returns per-month row counts, uncompressed size and an estimated wall-clock time. Call this ' +
  'before search_archives so you know whether the answer costs 2 seconds or 4 minutes.'

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatSearch(data: ArchiveSearchResponse): string {
  const lines: string[] = []
  for (const hit of data.hits) {
    const ts = hit.timestamp ? new Date(hit.timestamp).toISOString().replace('T', ' ').slice(0, 19) : ''
    lines.push(`${hit.month}  seq ${hit.seq}  ${hit.type}${hit.subtype ? `/${hit.subtype}` : ''}  ${ts}`)
    lines.push(`  conv: ${hit.conversationId}`)
    lines.push(`  ${hit.snippet}`)
    lines.push('')
  }
  lines.push(
    `${data.hits.length} hit(s) for "${data.query}" -- scanned ${data.scannedMonths.join(', ') || 'nothing'} ` +
      `(${data.rowsScanned.toLocaleString()} rows, ${mb(data.bytesScanned)}) in ${(data.elapsedMs / 1000).toFixed(1)}s`,
  )
  if (data.truncated) {
    const why = data.truncatedReason === 'limit' ? 'hit the result limit' : 'ran out of time budget'
    lines.push(
      `INCOMPLETE: ${why}. NOT searched: ${data.skippedMonths.join(', ') || 'rest of the last month'}. ` +
        'Narrow with `month`, or raise `limit`/`maxSeconds`, and tell the user the answer is partial.',
    )
  }
  return lines.join('\n')
}

export function formatPlan(plan: ArchivePlanResponse): string {
  if (!plan.configured || plan.months.length === 0) return 'No cold archives on this broker -- nothing to search.'
  const lines = plan.months.map(m => `  ${m.month}  ${m.rows.toLocaleString()} rows  ${mb(m.plaintextBytes)}`)
  lines.push(
    '',
    `${plan.totalRows.toLocaleString()} rows, ${mb(plan.totalPlaintextBytes)} to decompress and scan ` +
      `-- roughly ${plan.estimatedSeconds}s for all of it.`,
  )
  if (plan.unmeasuredMonths.length > 0) {
    lines.push(`NOTE: no meta for ${plan.unmeasuredMonths.join(', ')} -- this estimate is a floor, not a total.`)
  }
  return lines.join('\n')
}
