/**
 * The dispatcher's LOOKUP tools (plan §3 B5/B6) -- the cheap "ask an expert"
 * surface that searches what the broker ALREADY knows before spending money.
 *
 * `search_transcripts` is the headline (B5): the dispatcher greps the FTS index of
 * every past conversation ITSELF, for free, instead of waking a 180k-context
 * conversation behind the cost gate to ask it a question. Waking a conversation is
 * the expensive fallback; transcript search is the first move. (B6 adds the recap
 * lookups alongside it.)
 */

import { z } from 'zod'
import type { DispatchRuntime } from './runtime'
import { defineTool, type Toolset } from './tool-def'

const MAX_HITS = 12

export function lookupTools(rt: DispatchRuntime): Toolset {
  const tools: Toolset = {}
  if (rt.searchTranscripts) {
    const search = rt.searchTranscripts
    tools.search_transcripts = defineTool({
      description:
        'Search the full-text index of EVERY past conversation transcript. This is your cheap "ask an expert" move: prefer it over waking a conversation (which is expensive and gated). Returns the top matching snippets with their conversationId + seq so you can cite or, only if truly needed, revive the right conversation.',
      inputSchema: z.object({
        query: z.string().describe('FTS query -- words/phrases to find across all transcripts.'),
        limit: z.number().int().positive().nullable().describe('Max hits (default 12). Null = default.'),
      }),
      idempotent: true,
      execute: async a => {
        const { query, limit } = a as { query: string; limit: number | null }
        const hits = search(query, Math.min(limit ?? MAX_HITS, MAX_HITS))
        if (!hits.length) return { hits: [], note: `no transcript matches for "${query}"` }
        return {
          hits: hits.map(h => ({
            conversationId: h.conversationId,
            seq: h.seq,
            type: h.type,
            snippet: h.snippet,
          })),
        }
      },
    })
  }
  return tools
}
