/** MCP tools for COLD transcript archives.
 *
 *  Registered from its own module rather than inlined into mcp-server.ts, which
 *  is already a god-file at 800+ lines. The tool descriptions are the real
 *  product here: an agent picks between the indexed hot search and this
 *  unindexed scan purely on what these strings say, so they lead with the cost.
 */

import { existsSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { planArchiveSearch, searchArchives } from '../archive'

const ARCHIVE_DIR = existsSync('/data/archives') ? '/data/archives' : ''

const SEARCH_DESCRIPTION = [
  'SLOW, EXPENSIVE, LAST RESORT -- a grep over COLD transcript archives.',
  '',
  'Cold archives are whole months of transcript that have aged out of the hot database and now live as',
  'compressed NDJSON, one immutable file per month. They have NO INDEX. Searching them means decompressing',
  'and scanning every byte of every month in scope: seconds for one month, MINUTES for a full history, and',
  'a pinned CPU core the whole time.',
  '',
  'ALWAYS try search_transcripts FIRST -- it is an FTS5 index over the hot window and answers in milliseconds.',
  'Reach for this tool only when search_transcripts came back empty AND the thing you want is older than the',
  'hot window (roughly 90 days). Call archive_search_plan first to see what the scan will cost, and pass',
  '`month` whenever you can narrow it: one month is ~10x cheaper than the whole archive.',
  '',
  'Matching is literal substring by default (case-insensitive), or a JS regex with regex:true. There is no',
  'stemming and no ranking: "run" will NOT find "running". Results are newest month first, so a capped search',
  'returns the most recent matches.',
  '',
  'The response always reports scannedMonths, skippedMonths and truncated. If truncated is true the answer is',
  'INCOMPLETE -- say so rather than reporting the hits as the full picture.',
].join('\n')

const PLAN_DESCRIPTION = [
  "Cost a cold-archive search WITHOUT running it. Cheap: reads each month's meta sidecar, decompresses nothing.",
  'Returns per-month row counts, uncompressed size and an estimated wall-clock time for the scan.',
  'Call this before search_archives so you (and the user) know whether the answer costs 2 seconds or 4 minutes.',
].join('\n')

export function registerArchiveTools(mcp: McpServer): void {
  mcp.tool('archive_search_plan', PLAN_DESCRIPTION, { month: z.string().optional() }, async ({ month }) => {
    if (!ARCHIVE_DIR) return text('Cold archives are not configured on this broker.')
    const plan = planArchiveSearch(ARCHIVE_DIR, month ? [month] : undefined)
    return text(JSON.stringify(plan, null, 2))
  })

  mcp.tool(
    'search_archives',
    SEARCH_DESCRIPTION,
    {
      query: z.string(),
      month: z.string().optional().describe('YYYY-MM. Narrows the scan to one month -- use it whenever you can.'),
      conversationId: z.string().optional().describe('Filters results; does NOT reduce the bytes scanned.'),
      regex: z.boolean().optional().describe('Treat query as a JS regex, matched against the JSON-escaped line.'),
      caseSensitive: z.boolean().optional(),
      limit: z.number().optional().describe('Default 50. Stops the scan early, which shows up as truncated.'),
      maxSeconds: z.number().optional().describe('Wall-clock budget, default 60. Exceeding it truncates.'),
    },
    async ({ query, month, conversationId, regex, caseSensitive, limit, maxSeconds }) => {
      if (!ARCHIVE_DIR) return text('Cold archives are not configured on this broker.')
      const result = await searchArchives({
        archiveDir: ARCHIVE_DIR,
        query,
        regex: regex ?? false,
        caseSensitive: caseSensitive ?? false,
        limit: limit ?? 50,
        maxSeconds: maxSeconds ?? 60,
        ...(month && { months: [month] }),
        ...(conversationId && { conversationId }),
      })
      return text(JSON.stringify(result, null, 2))
    },
  )
}

function text(body: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: body }] }
}
