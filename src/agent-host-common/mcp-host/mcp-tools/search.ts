/**
 * MCP search tools -- progressive transcript access.
 *
 * Designed for minimal context consumption:
 *   1. search_transcripts (conversations mode) -> which conversations match?
 *   2. search_transcripts (snippets mode, + conversationId) -> entries within one
 *   3. get_transcript_context (aroundSeq or tail) -> full content window
 *
 * Both tools work WITHOUT a search term: search_transcripts browses when `query`
 * is omitted, and get_transcript_context takes `tail` when there is no seq to
 * centre on. Neither could reach the end of a conversation before that.
 *
 * Both call the broker over HTTP. The broker enforces permission gating.
 * Descriptions + schemas live in ./search-schemas, rendering in ./search-format.
 */

import { formatTranscriptWindow } from '../../../shared/transcript-window-format'
import { wsToHttpUrl } from '../../../shared/ws-url'
import { debug } from '../debug'
import { formatConversationsOutput, formatSnippetsOutput, type SearchResponse } from './search-format'
import {
  SEARCH_TRANSCRIPTS_DESCRIPTION,
  SEARCH_TRANSCRIPTS_SCHEMA,
  TRANSCRIPT_CONTEXT_DESCRIPTION,
  TRANSCRIPT_CONTEXT_SCHEMA,
} from './search-schemas'
import type { McpToolContext, ToolDef } from './types'

interface WindowResponse {
  entries: Array<{
    seq: number
    type: string
    subtype?: string
    content: unknown
    timestamp?: number
    conversationId?: string
  }>
  conversation?: { id: string; project?: string; title?: string; description?: string }
}

function errorResult(text: string) {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Copy defined values onto a query string. `null`/`undefined` entries are
 *  dropped, so a caller passes the whole shape once instead of guarding each
 *  field with its own `if`. */
function setQuery(url: URL, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value != null) url.searchParams.set(key, String(value))
  }
}

/** `types` arrives as an array from a well-behaved caller and a comma string
 *  from a sloppy one. Normalise to the comma list the broker expects. */
function typeList(types: unknown): string | null {
  if (types == null) return null
  const list = Array.isArray(types) ? types : String(types).split(',')
  return list.map(String).join(',') || null
}

/** How each output mode renders a search response. Unknown modes fall back to
 *  the grouped view, which is also the documented default. */
const OUTPUT_FORMATTERS: Record<string, (data: SearchResponse) => string> = {
  full: data => JSON.stringify(data, null, 2),
  snippets: formatSnippetsOutput,
  conversations: formatConversationsOutput,
}

/** Why a transcript-window request cannot be served, or null if it can. */
function windowRequestError(conversationId: string, params: Record<string, unknown>): string | null {
  if (!conversationId) return 'Error: conversationId is required'
  if (params.aroundSeq == null && params.aroundId == null && params.tail == null) {
    return 'Error: aroundSeq, aroundId, or tail required'
  }
  return null
}

type BrokerFetch<T> = { ok: true; data: T } | { ok: false; result: ReturnType<typeof errorResult> }

/** GET a broker endpoint and parse it, or hand back the error result to return
 *  verbatim. `label` names the tool in the debug line and the user-facing text,
 *  which is the only thing that differed between the two call sites. */
async function fetchBroker<T>(url: URL, headers: Record<string, string>, label: string): Promise<BrokerFetch<T>> {
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      debug(`[channel] ${label}: HTTP ${res.status} ${errBody.slice(0, 200)}`)
      return {
        ok: false,
        result: errorResult(`${label} failed (${res.status}): ${errBody.slice(0, 200) || 'unknown'}`),
      }
    }
    return { ok: true, data: (await res.json()) as T }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    debug(`[channel] ${label} error: ${msg}`)
    return { ok: false, result: errorResult(`${label} request failed: ${msg}`) }
  }
}

export function registerSearchTools(ctx: McpToolContext): Record<string, ToolDef> {
  function authHeaders(): Record<string, string> {
    return ctx.brokerSecret ? { Authorization: `Bearer ${ctx.brokerSecret}` } : {}
  }

  function brokerHttp(): string | null {
    if (ctx.noBroker || !ctx.brokerUrl) return null
    return wsToHttpUrl(ctx.brokerUrl)
  }

  return {
    search_transcripts: {
      description: SEARCH_TRANSCRIPTS_DESCRIPTION,
      inputSchema: SEARCH_TRANSCRIPTS_SCHEMA,
      async handle(params) {
        const http = brokerHttp()
        if (!http) return errorResult('Error: broker not available')
        // No query is BROWSE, not an error -- "my last three messages" has no
        // search term to give, and rejecting it left that question unanswerable.
        const query = String(params.query || '').trim()
        const output = String(params.output || 'conversations')

        const url = new URL(`${http}/api/search`)
        url.searchParams.set('q', query)
        setQuery(url, {
          conversation: params.conversationId || null,
          project: params.project || null,
          type: typeList(params.types),
          sort: params.sort === 'recency' ? 'recency' : null,
          limit: params.limit,
          offset: params.offset,
        })

        const fetched = await fetchBroker<SearchResponse>(url, authHeaders(), 'Search')
        if (!fetched.ok) return fetched.result

        const render = OUTPUT_FORMATTERS[output] ?? formatConversationsOutput
        return { content: [{ type: 'text', text: render(fetched.data) }] }
      },
    },

    get_transcript_context: {
      description: TRANSCRIPT_CONTEXT_DESCRIPTION,
      inputSchema: TRANSCRIPT_CONTEXT_SCHEMA,
      async handle(params) {
        const http = brokerHttp()
        if (!http) return errorResult('Error: broker not available')
        const conversationId = String(params.conversationId || '').trim()
        const invalid = windowRequestError(conversationId, params)
        if (invalid) return errorResult(invalid)

        const url = new URL(`${http}/api/transcript-window`)
        setQuery(url, {
          conversation: conversationId,
          aroundSeq: params.aroundSeq,
          aroundId: params.aroundId,
          tail: params.tail,
          before: params.before,
          after: params.after,
        })

        const fetched = await fetchBroker<WindowResponse>(url, authHeaders(), 'Context fetch')
        if (!fetched.ok) return fetched.result

        if (String(params.format || 'text') === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(fetched.data, null, 2) }] }
        }
        const maxBytes = typeof params.maxBytesPerEntry === 'number' ? params.maxBytesPerEntry : undefined
        const text = formatTranscriptWindow(fetched.data.entries, fetched.data.conversation, {
          maxBytesPerEntry: maxBytes,
        })
        return { content: [{ type: 'text', text }] }
      },
    },
  }
}
