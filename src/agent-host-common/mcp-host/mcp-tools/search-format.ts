/**
 * Rendering for search_transcripts results -- the broker's JSON turned into the
 * compact text an agent actually reads.
 *
 * Two modes share these formatters: a ranked FTS search and a query-less browse.
 * They differ only in what the header line can honestly claim, which is why
 * `describeResult` exists rather than a query string interpolated everywhere.
 */

export interface SearchHit {
  id: number
  conversationId: string
  seq: number
  type: string
  subtype?: string
  snippet: string
  score: number
  content: unknown
  createdAt: number
  conversation?: { id: string; project?: string; title?: string; description?: string }
  window?: unknown[]
}

export interface SearchResponse {
  hits: SearchHit[]
  total: number
  query: string
  limit: number
  offset: number
  /** `browse` when no query was given -- a newest-first listing, nothing ranked. */
  mode?: 'search' | 'browse'
}

/** Header line for either mode. Browse has no query to quote, so quoting an
 *  empty string ("0 hits for \"\"") would read like a broken call. */
function describeResult(data: SearchResponse, subject: string): string {
  return data.mode === 'browse'
    ? `${subject} (newest first, limit ${data.limit}, offset ${data.offset})`
    : `${subject} for "${data.query}"`
}

function cleanSnippet(snippet: string): string {
  return snippet
    .replace(/<\/?mark>/g, '*')
    .replace(/\.\.\./g, '...')
    .trim()
}

export function formatConversationsOutput(data: SearchResponse): string {
  const grouped = new Map<string, { conv: SearchHit['conversation']; hits: SearchHit[]; bestScore: number }>()

  for (const hit of data.hits) {
    const cid = hit.conversationId
    const existing = grouped.get(cid)
    if (existing) {
      existing.hits.push(hit)
      if (hit.score < existing.bestScore) existing.bestScore = hit.score
    } else {
      grouped.set(cid, { conv: hit.conversation, hits: [hit], bestScore: hit.score })
    }
  }

  const lines: string[] = [describeResult(data, `Found ${data.total} entries across ${grouped.size} conversations`), '']

  for (const [cid, group] of grouped) {
    lines.push(`[${cid}] ${group.conv?.title || 'untitled'}`)
    lines.push(`  project: ${group.conv?.project || ''}  |  hits: ${group.hits.length}`)
    const best = group.hits[0]
    if (best?.snippet) {
      lines.push(`  ${data.mode === 'browse' ? 'latest' : 'best match'}: ${cleanSnippet(best.snippet)}`)
    }
    lines.push('')
  }

  lines.push(
    'Drill in: search_transcripts({ conversationId, output: "snippets" }) -- add `query` to search, omit it to browse',
  )
  return lines.join('\n')
}

export function formatSnippetsOutput(data: SearchResponse): string {
  const lines: string[] = [describeResult(data, `${data.total} entries`), '']

  for (const hit of data.hits) {
    const convTitle = hit.conversation?.title || ''
    const ts = hit.createdAt ? new Date(hit.createdAt).toISOString().replace('T', ' ').slice(0, 19) : ''
    const clean = cleanSnippet(hit.snippet || '')

    lines.push(`seq ${hit.seq}  |  ${hit.type}${hit.subtype ? `/${hit.subtype}` : ''}  |  ${ts}  |  ${convTitle}`)
    lines.push(`  conv: ${hit.conversationId}`)
    if (clean) lines.push(`  ${clean}`)
    lines.push('')
  }

  lines.push(
    'Expand: get_transcript_context({ conversationId, aroundSeq }) -- or { conversationId, tail: N } for the end',
  )
  return lines.join('\n')
}
