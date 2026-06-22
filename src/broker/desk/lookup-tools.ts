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
import { getRecapOrchestrator } from '../recap-orchestrator'
import { resolveDeskProject } from './projects'
import type { DispatchRuntime } from './runtime'
import { defineTool, type Toolset } from './tool-def'

const MAX_HITS = 12
const MAX_RECAPS = 10

/** The recap LOOKUP tools (B6): read existing period recaps -- already-condensed
 *  "what happened in this project" memory. Triggering a recap is deferred (it is
 *  async + needs a full scope payload; the recap_available hook already folds
 *  finished recaps into project memory). Degrades to nothing if the recap
 *  subsystem isn't initialized (e.g. in a unit test). */
function recapTools(): Toolset {
  const orch = getRecapOrchestrator()
  if (!orch) return {}
  return {
    list_recaps: defineTool({
      description:
        'List existing period recaps (already-condensed "what happened here" summaries), most recent first. Optionally scope to a project. Use to catch up on a project cheaply before deciding to wake anything.',
      inputSchema: z.object({
        project: z.string().nullable().describe('Project name/slug/uri to scope to, or null for all.'),
      }),
      idempotent: true,
      execute: a => {
        const { project } = a as { project: string | null }
        const projectUri = project ? (resolveDeskProject(project)?.projectUri ?? undefined) : undefined
        return orch.list({ projectUri, limit: MAX_RECAPS }).map(r => ({
          recapId: r.id,
          project: r.projectUri,
          period: r.periodLabel,
          title: r.title,
          status: r.status,
          completedAt: r.completedAt,
        }))
      },
    }),
    get_recap: defineTool({
      description: 'Read the full markdown of one recap by its recapId (from list_recaps).',
      inputSchema: z.object({ recapId: z.string().describe('The recap id from list_recaps.') }),
      idempotent: true,
      execute: a => {
        const { recapId } = a as { recapId: string }
        const md = orch.getMarkdown(recapId)
        return md ? { recapId, markdown: md } : { recapId, error: 'no such recap (or not yet complete)' }
      },
    }),
  }
}

export function lookupTools(rt: DispatchRuntime): Toolset {
  const tools: Toolset = { ...recapTools() }
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
