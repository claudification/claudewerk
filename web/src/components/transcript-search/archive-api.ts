/** Client for the COLD archive search.
 *
 *  Kept separate from the hot search on purpose. The hot search is an indexed
 *  FTS5 query that runs on every keystroke; this one decompresses and scans
 *  whole months and can take minutes, so it is never debounced, never automatic,
 *  and never issued without the user asking for it.
 */

export interface ArchiveHit {
  month: string
  conversationId: string
  seq: number
  type: string
  subtype: string | null
  uuid: string
  timestamp: number
  snippet: string
}

export interface ArchiveSearchResponse {
  query: string
  regex: boolean
  hits: ArchiveHit[]
  scannedMonths: string[]
  skippedMonths: string[]
  rowsScanned: number
  bytesScanned: number
  elapsedMs: number
  truncated: boolean
  truncatedReason: '' | 'limit' | 'time'
}

export interface ArchivePlan {
  configured: boolean
  months: Array<{ month: string; rows: number; plaintextBytes: number; compressedBytes: number }>
  totalRows: number
  totalPlaintextBytes: number
  totalCompressedBytes: number
  estimatedSeconds: number
  unmeasuredMonths: string[]
}

/** Types worth reading. Cold months are mostly attachment and tool_result rows
 *  carrying huge JSON payloads; unfiltered they bury the answer. */
const DEFAULT_COLD_TYPES = ['user', 'assistant']

export async function fetchArchivePlan(): Promise<ArchivePlan | null> {
  try {
    const res = await fetch('/api/archives/search/plan')
    if (!res.ok) return null
    const plan = (await res.json()) as ArchivePlan
    return plan.configured ? plan : null
  } catch {
    return null
  }
}

export interface ColdSearchOptions {
  includeToolOutput?: boolean
  limit?: number
  maxSeconds?: number
}

export async function searchColdArchives(
  query: string,
  { includeToolOutput = false, limit = 50, maxSeconds = 120 }: ColdSearchOptions = {},
): Promise<ArchiveSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit), maxSeconds: String(maxSeconds) })
  if (!includeToolOutput) params.set('types', DEFAULT_COLD_TYPES.join(','))
  const res = await fetch(`/api/archives/search?${params}`)
  if (!res.ok) throw new Error(`cold search failed: HTTP ${res.status}`)
  return (await res.json()) as ArchiveSearchResponse
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 / 1024)} MB`
}
