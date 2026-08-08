/**
 * MCP tools for COLD transcript archives -- the host half.
 *
 * search_transcripts covers the hot FTS5 index. Everything older than the hot
 * window lives in compressed monthly archives with no index at all, and these
 * two tools are the only way an agent can reach it: one to price the scan, one
 * to run it.
 *
 * Both call the broker over HTTP; the broker owns the archive directory and
 * enforces the permission gate. Output is formatted rather than dumped, and it
 * ALWAYS ends with what was scanned and what was skipped -- a cold search that
 * reports hits without reporting coverage invites the agent to conclude that
 * something does not exist when it simply was not read.
 */

import { wsToHttpUrl } from '../../../shared/ws-url'
import { debug } from '../debug'
import {
  type ArchivePlanResponse,
  type ArchiveSearchResponse,
  formatPlan,
  formatSearch,
  PLAN_DESCRIPTION,
  SEARCH_DESCRIPTION,
} from './archive-search-format'
import type { McpToolContext, ToolDef } from './types'

export function registerArchiveSearchTools(ctx: McpToolContext): Record<string, ToolDef> {
  function brokerHttp(): string | null {
    if (ctx.noBroker || !ctx.brokerUrl) return null
    return wsToHttpUrl(ctx.brokerUrl)
  }

  /** Returns the parsed body, or an error string to hand straight back. */
  async function get<T>(path: string, params: URLSearchParams): Promise<T | string> {
    const http = brokerHttp()
    if (!http) return 'Error: broker not available'
    const url = new URL(`${http}${path}`)
    url.search = params.toString()
    try {
      const res = await fetch(url, {
        headers: ctx.brokerSecret ? { Authorization: `Bearer ${ctx.brokerSecret}` } : {},
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        debug(`[channel] ${path}: HTTP ${res.status} ${body.slice(0, 200)}`)
        return `Archive request failed (${res.status}): ${body.slice(0, 200) || 'unknown'}`
      }
      return (await res.json()) as T
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      debug(`[channel] ${path} error: ${msg}`)
      return `Archive request failed: ${msg}`
    }
  }

  function searchParamsFrom(params: Record<string, unknown>, query: string): URLSearchParams {
    const qs = new URLSearchParams({ q: query })
    if (params.month) qs.set('month', String(params.month))
    if (params.conversationId) qs.set('conversation', String(params.conversationId))
    if (params.types) {
      const types = Array.isArray(params.types) ? params.types : String(params.types).split(',')
      qs.set('types', types.map(String).join(','))
    }
    if (params.regex) qs.set('regex', '1')
    if (params.caseSensitive) qs.set('caseSensitive', '1')
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.maxSeconds != null) qs.set('maxSeconds', String(params.maxSeconds))
    return qs
  }

  return {
    archive_search_plan: {
      description: PLAN_DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: { month: { type: 'string', description: 'YYYY-MM. Omit to cost every archived month.' } },
      },
      async handle(params) {
        const qs = new URLSearchParams()
        if (params.month) qs.set('month', String(params.month))
        const data = await get<ArchivePlanResponse>('/api/archives/search/plan', qs)
        if (typeof data === 'string') return { content: [{ type: 'text', text: data }], isError: true }
        return { content: [{ type: 'text', text: formatPlan(data) }] }
      },
    },

    search_archives: {
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Literal substring, or a JS regex when regex:true.' },
          month: { type: 'string', description: 'YYYY-MM. Narrows the scan -- use it whenever you can.' },
          conversationId: { type: 'string', description: 'Filters results; does NOT reduce the bytes scanned.' },
          types: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Entry types to keep, e.g. ["user","assistant"]. Cold months are mostly attachment and tool_result ' +
              'rows full of JSON payloads, which will bury the answer. Use this first.',
          },
          regex: { type: 'boolean', description: 'Treat query as a JS regex against the JSON-escaped line.' },
          caseSensitive: { type: 'boolean', description: 'Default false.' },
          limit: { type: 'number', description: 'Max hits (default 50). Stops the scan early -> truncated.' },
          maxSeconds: { type: 'number', description: 'Wall-clock budget (default 60). Exceeding it -> truncated.' },
        },
        required: ['query'],
      },
      async handle(params) {
        const query = String(params.query || '').trim()
        if (!query) return { content: [{ type: 'text', text: 'Error: query is required' }], isError: true }
        const data = await get<ArchiveSearchResponse>('/api/archives/search', searchParamsFrom(params, query))
        if (typeof data === 'string') return { content: [{ type: 'text', text: data }], isError: true }
        return { content: [{ type: 'text', text: formatSearch(data) }] }
      },
    },
  }
}
