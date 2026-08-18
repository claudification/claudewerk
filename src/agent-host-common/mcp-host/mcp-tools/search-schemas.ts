/**
 * Tool descriptions + input schemas for search_transcripts / get_transcript_context.
 *
 * These are the whole interface an agent gets. A capability the description does
 * not spell out does not exist in practice: browse mode shipped once already as
 * an unadvertised `query`-optional path and agents kept passing a query anyway,
 * so the recipes below are written as literal calls, not prose.
 */

export const SEARCH_TRANSCRIPTS_DESCRIPTION =
  'Search OR browse conversation transcripts. Progressive: start broad, drill in.\n\n' +
  'QUERY IS OPTIONAL. Omit it to BROWSE -- newest entries first, filters only, no search term.\n' +
  '  search_transcripts({ conversationId: "abc...", types: ["user"], limit: 3, output: "snippets" })\n' +
  '    -> the last 3 messages the USER sent in that conversation, newest first.\n' +
  '  search_transcripts({ conversationId: "abc...", limit: 20, output: "snippets" })\n' +
  '    -> the last 20 entries of any kind (the tail of the conversation).\n' +
  '  Browse is always newest-first; `sort` is ignored because nothing was ranked.\n\n' +
  'OUTPUT MODES (progressive disclosure):\n' +
  '  1. "conversations" (default) -- which conversations match? Grouped, compact.\n' +
  '  2. "snippets" -- individual hits, newest-first when browsing. Add conversationId to focus.\n' +
  '  3. "full" -- raw transcript entries (large! use sparingly).\n\n' +
  'TYPICAL FLOW:\n' +
  '  search_transcripts({ query: "auth" })                          -> conversations list\n' +
  '  search_transcripts({ query: "auth", conversationId: "abc..." , output: "snippets" }) -> snippets in that conversation\n' +
  '  get_transcript_context({ conversationId: "abc...", aroundSeq: 42 })  -> full content window\n' +
  '  get_transcript_context({ conversationId: "abc...", tail: 10 })       -> the END of a conversation, full content\n\n' +
  'QUERY SYNTAX (FTS5, when you do pass one):\n' +
  '  bareword: `migration` | phrase: `"merge conflict"` | boolean: `auth AND token`\n' +
  '  prefix: `migrat*` | NOT: `error NOT timeout` | NEAR: `NEAR(foo bar, 5)`\n\n' +
  'FILTERS: conversationId, project (URI or glob `path/*`), types (["user","assistant",...]).\n' +
  'SORT: "relevance" (default, best match first) or "recency" (newest first). Search only.'

export const SEARCH_TRANSCRIPTS_SCHEMA = {
  type: 'object' as const,
  properties: {
    query: {
      type: 'string',
      description:
        'FTS5 search query. OPTIONAL -- omit it to browse the newest entries matching the filters instead of searching.',
    },
    output: {
      type: 'string',
      enum: ['conversations', 'snippets', 'full'],
      description:
        'Output mode. "conversations" (default) = grouped by conversation. "snippets" = individual hits. "full" = raw entries.',
    },
    conversationId: { type: 'string', description: 'Limit to one conversation.' },
    project: { type: 'string', description: 'Filter by project URI (exact or glob suffix `path/*`).' },
    types: {
      type: 'array',
      items: { type: 'string' },
      description: 'Filter by entry types: "user", "assistant", "tool_use", "tool_result", etc.',
    },
    sort: {
      type: 'string',
      enum: ['relevance', 'recency'],
      description:
        'Result order. "relevance" (default) = best FTS match first. "recency" = newest transcript entry first (date desc); use to surface recent activity regardless of match quality. Ignored when browsing.',
    },
    limit: { type: 'number', description: 'Max results (1-100, default 20).' },
    offset: { type: 'number', description: 'Pagination offset (default 0).' },
  },
  required: [] as string[],
}

export const TRANSCRIPT_CONTEXT_DESCRIPTION =
  'Sliding window of transcript entries around a point -- or the END of a conversation. ' +
  'Use after search_transcripts to read full content.\n\n' +
  'THREE WAYS IN: aroundSeq (from search hits), aroundId, or tail.\n' +
  '  get_transcript_context({ conversationId, tail: 10 }) -> the last 10 entries, no seq needed.\n' +
  '  tail is the fast path for "what just happened here" / "read the end of this conversation".\n' +
  '  It returns a CONTIGUOUS window (every entry type). To filter by type, browse instead:\n' +
  '  search_transcripts({ conversationId, types: ["user"], limit: 3, output: "snippets" }).\n\n' +
  'Adjust before/after (0-50) to expand a centred window.\n' +
  'Output is compact text by default: per-entry header + canonical body, base64 stripped, ' +
  'duplicate tool_result wrappers collapsed, per-entry byte cap with head/tail elision. ' +
  'Walk pointers (next/prev) are printed at the bottom -- no seq arithmetic needed.\n' +
  'Set format:"json" for the raw row dump (large; rarely useful). ' +
  'Set maxBytesPerEntry to expand or tighten the per-entry cap (default 2000).'

export const TRANSCRIPT_CONTEXT_SCHEMA = {
  type: 'object' as const,
  properties: {
    conversationId: { type: 'string', description: 'Conversation to read from.' },
    aroundSeq: { type: 'number', description: 'Center on this sequence number (preferred). From search hit results.' },
    aroundId: { type: 'number', description: 'Center on this entry id (fallback).' },
    tail: {
      type: 'number',
      description:
        'Return the LAST N entries instead of centering (1-100). Use when you want the end of the conversation and have no seq to center on.',
    },
    before: { type: 'number', description: 'Entries before center (0-50, default 5).' },
    after: { type: 'number', description: 'Entries after center (0-50, default 5).' },
    format: {
      type: 'string',
      enum: ['text', 'json'],
      description: 'Output format. "text" (default) = compact human-readable. "json" = raw rows.',
    },
    maxBytesPerEntry: {
      type: 'number',
      description: 'Per-entry body byte cap for text format (default 2000). Ignored for json.',
    },
  },
  required: ['conversationId'],
}
