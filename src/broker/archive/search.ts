/** Grep over cold archives. SLOW BY CONSTRUCTION -- read this before using it.
 *
 *  The hot database has an FTS5 index. Cold archives have nothing: they are
 *  immutable compressed text, and searching one means decompressing every byte
 *  of it and testing every line. A month is ~2.5 GB of plaintext; a full history
 *  is tens of GB. There is no index to add without giving back the property that
 *  makes archives worth having (one flat immutable file per month, no companion
 *  state to keep in sync).
 *
 *  So this is deliberately shaped like `grep`, not like a search engine:
 *  - literal substring by default, optional regex, no stemming and no ranking
 *  - newest month first, so a capped search returns the most recent matches
 *  - a hit cap AND a wall-clock budget, both reported in the result
 *  - what was scanned and what was skipped is always returned, never implied
 *
 *  Nothing here truncates silently. A caller that shows hits without showing
 *  `skippedMonths` is lying to the user about coverage.
 */

import { listArchives } from './list'
import { scanNdjsonZstd } from './scan'
import { buildMatcher, snippetAround } from './search-match'

const DEFAULT_LIMIT = 50
const DEFAULT_MAX_SECONDS = 120
const DEFAULT_CONTEXT_CHARS = 160
/** Checking the clock per line costs more than the match does. */
const CLOCK_EVERY_LINES = 4096

export interface ArchiveSearchOptions {
  archiveDir: string
  query: string
  /** Treat `query` as a JS regex against the RAW (JSON-escaped) line. */
  regex?: boolean
  caseSensitive?: boolean
  /** Restrict to these `YYYY-MM` months. Default: every archived month. */
  months?: string[]
  conversationId?: string
  limit?: number
  maxSeconds?: number
  contextChars?: number
  now?: () => number
}

export interface ArchiveSearchHit {
  month: string
  conversationId: string
  seq: number
  type: string
  subtype: string | null
  uuid: string
  timestamp: number
  snippet: string
}

export interface ArchiveSearchResult {
  query: string
  regex: boolean
  hits: ArchiveSearchHit[]
  /** Months actually read to completion or to the cut-off. */
  scannedMonths: string[]
  /** Months that were in scope but never opened, because the cap or the clock
   *  ran out first. Show this. */
  skippedMonths: string[]
  rowsScanned: number
  bytesScanned: number
  elapsedMs: number
  truncated: boolean
  truncatedReason: '' | 'limit' | 'time'
}

function rowToHit(row: Record<string, unknown>, month: string, snippet: string): ArchiveSearchHit {
  return {
    month,
    conversationId: String(row.conversation_id ?? ''),
    seq: Number(row.seq ?? 0),
    type: String(row.type ?? ''),
    subtype: row.subtype == null ? null : String(row.subtype),
    uuid: String(row.uuid ?? ''),
    timestamp: Number(row.timestamp ?? 0),
    snippet,
  }
}

/** Months in scope, newest first. */
function monthsInScope(archiveDir: string, wanted?: string[]): Array<{ month: string; archivePath: string }> {
  const available = listArchives(archiveDir).map(a => ({ month: a.month, archivePath: a.archivePath }))
  const filtered = wanted?.length ? available.filter(a => wanted.includes(a.month)) : available
  return filtered.sort((a, b) => b.month.localeCompare(a.month))
}

export async function searchArchives(opts: ArchiveSearchOptions): Promise<ArchiveSearchResult> {
  const {
    archiveDir,
    query,
    regex = false,
    caseSensitive = false,
    months,
    conversationId,
    limit = DEFAULT_LIMIT,
    maxSeconds = DEFAULT_MAX_SECONDS,
    contextChars = DEFAULT_CONTEXT_CHARS,
    now = Date.now,
  } = opts

  if (!query) throw new Error('archive search needs a query')

  const matcher = buildMatcher(query, { regex, caseSensitive })
  const scope = monthsInScope(archiveDir, months)
  const started = now()
  const deadline = started + maxSeconds * 1000

  const hits: ArchiveSearchHit[] = []
  const scannedMonths: string[] = []
  let rowsScanned = 0
  let bytesScanned = 0
  let truncatedReason: '' | 'limit' | 'time' = ''
  let sinceClockCheck = 0
  let outOfTime = false

  for (const [index, entry] of scope.entries()) {
    // The in-scan clock only ticks every CLOCK_EVERY_LINES, so a month that ends
    // before the next tick would otherwise let an expired budget open the next
    // one. Check the deadline at every boundary too.
    if (!truncatedReason && now() > deadline) truncatedReason = 'time'
    if (truncatedReason) {
      return {
        query,
        regex,
        hits,
        scannedMonths,
        skippedMonths: scope.slice(index).map(s => s.month),
        rowsScanned,
        bytesScanned,
        elapsedMs: now() - started,
        truncated: true,
        truncatedReason,
      }
    }

    scannedMonths.push(entry.month)
    const stats = await scanNdjsonZstd(entry.archivePath, line => {
      if (++sinceClockCheck >= CLOCK_EVERY_LINES) {
        sinceClockCheck = 0
        if (now() > deadline) {
          outOfTime = true
          return false
        }
      }
      if (!matcher.test(line)) return true

      const row = JSON.parse(line) as Record<string, unknown>
      if (conversationId && row.conversation_id !== conversationId) return true
      hits.push(rowToHit(row, entry.month, snippetAround(String(row.content ?? ''), matcher, contextChars)))
      return hits.length < limit
    })

    rowsScanned += stats.lines
    bytesScanned += stats.bytes
    if (outOfTime) truncatedReason = 'time'
    else if (hits.length >= limit) truncatedReason = 'limit'
  }

  return {
    query,
    regex,
    hits,
    scannedMonths,
    skippedMonths: [],
    rowsScanned,
    bytesScanned,
    elapsedMs: now() - started,
    truncated: Boolean(truncatedReason),
    truncatedReason,
  }
}
