/**
 * MCP Server endpoint -- exposes Claudwerk tools via Streamable HTTP MCP.
 *
 * External agents (Chat API, etc.) connect to /mcp to use Claudwerk's capabilities:
 * notify, share_file, search_transcripts, send_message, spawn_conversation,
 * list_conversations, project_list, project_set_status.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { formatTranscriptWindow } from '../../shared/transcript-window-format'
import { BUILD_VERSION } from '../../shared/version'
import { resolveAuth } from '../auth-routes'
import type { ConversationStore } from '../conversation-store'
import { deliverDispatcherReport } from '../desk/async-impulse'
import { parseOrbTarget, relayToOrb } from '../desk/orb-channel'
import { runDispatch } from '../desk/runtime'
import { listThreads } from '../desk/threads'
import { getGlobalSettings } from '../global-settings'
import { getProjectSettings } from '../project-settings'
import { isPushConfigured, sendPushToAll } from '../push'
import { dispatchSpawn, type SpawnDispatchDeps } from '../spawn-dispatch'
import type { StoreDriver } from '../store/types'
import { listWebControlClients, resolveImplicitClient, sendWebControlRequest } from '../web-control'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function toolText(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], isError }
}

/** Resolve the explicit-or-implicit web-control target, then run one op. */
async function runWebControlOp(
  clientId: string | undefined,
  op: Parameters<typeof sendWebControlRequest>[1],
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const target = clientId ? { clientId } : resolveImplicitClient()
  if ('error' in target) return toolText(target.error, true)
  const r = await sendWebControlRequest(target.clientId, op, args)
  if (!r.ok) return toolText(r.error ?? `web op '${op}' failed`, true)
  return toolText(typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? { ok: true }, null, 2))
}

export interface LineageRow {
  conversationId: string
  title?: string
  project?: string
  status?: string
  agentHostType?: string
  parentConversationId?: string
  rootConversationId?: string
  directChildCount: number
}

/** Render a forest of conversations as an ASCII spawn tree.
 *
 *  Roots = rows whose parent isn't in the row set (or is missing entirely).
 *  When the input is filtered (e.g. status='active'), parents may live
 *  outside the result -- those rows still surface as forest roots so the
 *  caller doesn't lose them. */
export function renderLineageTree(rows: LineageRow[]): string {
  if (rows.length === 0) return '(no conversations)'
  const byId = new Map<string, LineageRow>()
  for (const r of rows) byId.set(r.conversationId, r)
  const childrenOf = new Map<string, LineageRow[]>()
  const roots: LineageRow[] = []
  for (const r of rows) {
    const parent = r.parentConversationId
    if (parent && byId.has(parent)) {
      const arr = childrenOf.get(parent) ?? []
      arr.push(r)
      childrenOf.set(parent, arr)
    } else {
      roots.push(r)
    }
  }
  const sortRows = (xs: LineageRow[]) =>
    xs.slice().sort((a, b) => (a.title ?? a.conversationId).localeCompare(b.title ?? b.conversationId))

  const lines: string[] = []
  function emit(row: LineageRow, prefix: string, isLast: boolean, isRoot: boolean) {
    const branch = isRoot ? '' : isLast ? '└── ' : '├── '
    const title = row.title?.trim() ? row.title.trim() : '(untitled)'
    const tags = [row.status, row.agentHostType, row.project].filter(Boolean).join(' · ')
    const extra = row.directChildCount > 0 ? ` (+${row.directChildCount} children)` : ''
    lines.push(`${prefix}${branch}${row.conversationId}  [${tags}]  ${title}${extra}`)
    const kids = sortRows(childrenOf.get(row.conversationId) ?? [])
    const nextPrefix = isRoot ? prefix : prefix + (isLast ? '    ' : '│   ')
    kids.forEach((kid, i) => {
      emit(kid, nextPrefix, i === kids.length - 1, false)
    })
  }
  const sortedRoots = sortRows(roots)
  sortedRoots.forEach((root, i) => {
    if (i > 0) lines.push('')
    emit(root, '', i === sortedRoots.length - 1, true)
  })
  return lines.join('\n')
}

/**
 * Build the broker's external MCP server with every tool registered. Exported so
 * the catalog parity test (mcp-catalog/catalog.parity.test.ts) can introspect the
 * bound tool-name set via `._registeredTools` without standing up a real store.
 */
export function createMcpServer(
  conversationStore: ConversationStore,
  store: StoreDriver,
  callerConversationId?: string | null,
): McpServer {
  const mcp = new McpServer(
    { name: 'claudwerk', version: BUILD_VERSION?.gitHashShort || '0.1.0' },
    { capabilities: { tools: {} } },
  )

  // ─── notify ─────────────────────────────────────────────────────────
  mcp.tool(
    'notify',
    "Send a push notification to the user's registered devices (phone, browser). Use when a long-running task completes or you need the user's attention. Delivered via VAPID web-push to all subscribed devices AND broadcast to live dashboard sockets.",
    { message: z.string(), title: z.string().optional() },
    async ({ message, title }) => {
      const wsPayload = JSON.stringify({
        type: 'notification',
        title: title || 'Claudwerk',
        body: message,
        timestamp: Date.now(),
      })
      let wsDelivered = 0
      for (const ws of conversationStore.getSubscribers()) {
        try {
          ws.send(wsPayload)
          wsDelivered++
        } catch {
          /* dead socket */
        }
      }

      let pushSent = 0
      let pushFailed = 0
      if (isPushConfigured()) {
        const result = await sendPushToAll({
          title: title || 'Claudwerk',
          body: message,
        })
        pushSent = result.sent
        pushFailed = result.failed
      }

      return {
        content: [
          {
            type: 'text',
            text: `Notification dispatched: ws=${wsDelivered}, push_sent=${pushSent}, push_failed=${pushFailed}`,
          },
        ],
      }
    },
  )

  // ─── search_transcripts ─────────────────────────────────────────────
  mcp.tool(
    'search_transcripts',
    'FTS5 full-text search across every conversation transcript stored by the broker. Use to find prior decisions, code snippets, or context from past conversations. Default `output: "conversations"` returns one row per matching conversation; `output: "snippets"` returns the actual matching transcript entries with seq numbers (feed seq into get_transcript_context to expand).',
    {
      query: z.string(),
      output: z.enum(['conversations', 'snippets']).optional(),
      limit: z.number().optional(),
    },
    async ({ query, output, limit }) => {
      const hits = store.transcripts.search(query, { limit: limit || 20 })
      if (output === 'snippets') {
        const snippets = hits.map(h => ({
          conversationId: h.conversationId,
          seq: h.seq,
          type: h.type,
          snippet: h.snippet,
          timestamp: h.timestamp,
        }))
        return { content: [{ type: 'text', text: JSON.stringify(snippets, null, 2) }] }
      }
      // Group by conversation
      const convMap = new Map<string, { count: number; topSnippet: string }>()
      for (const h of hits) {
        const existing = convMap.get(h.conversationId)
        if (existing) {
          existing.count++
        } else {
          convMap.set(h.conversationId, { count: 1, topSnippet: h.snippet })
        }
      }
      const conversations = Array.from(convMap.entries()).map(([id, data]) => {
        const conv = conversationStore.getConversation(id)
        return {
          conversationId: id,
          title: conv?.title,
          project: conv?.project,
          status: conv?.status,
          matchCount: data.count,
          topSnippet: data.topSnippet,
        }
      })
      return { content: [{ type: 'text', text: JSON.stringify(conversations, null, 2) }] }
    },
  )

  // ─── get_transcript_context ─────────────────────────────────────────
  mcp.tool(
    'get_transcript_context',
    'Sliding window of transcript entries around a given seq number. Use after search_transcripts (with output:"snippets") to expand context around a hit -- pass the conversationId and seq from the search result. Output is compact text by default: per-entry header + canonical body, base64 stripped, duplicate tool_result wrappers collapsed, per-entry byte cap, walk pointers at the bottom. Set format:"json" for the raw row dump.',
    {
      conversationId: z.string(),
      seq: z.number(),
      window: z.number().optional(),
      format: z.enum(['text', 'json']).optional(),
      maxBytesPerEntry: z.number().optional(),
    },
    async ({ conversationId, seq, window: windowSize, format, maxBytesPerEntry }) => {
      const entries = store.transcripts.getWindow(conversationId, {
        aroundSeq: seq,
        before: windowSize || 5,
        after: windowSize || 5,
      })
      if (format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] }
      }
      const conv = conversationStore.getConversation(conversationId)
      const convMeta = conv
        ? { id: conv.id, project: conv.project, title: conv.title, description: conv.description }
        : { id: conversationId }
      const text = formatTranscriptWindow(entries, convMeta, { maxBytesPerEntry })
      return { content: [{ type: 'text', text }] }
    },
  )

  // ─── send_message ───────────────────────────────────────────────────
  mcp.tool(
    'send_message',
    'Send a message to one or more other conversations (CC, Hermes, chat-api, etc.). The recipient sees the message wrapped in a <channel> tag with the from/intent/conversation_id attributes preserved -- they reply by calling this tool back with the same conversation_id. Pass `to` as a string for one recipient or an array for multicast (max 25). Multicast returns a per-target breakdown. Reserved targets (always allowed, no link approval): `dispatcher` reports a dispatched quest\'s findings back to your dispatcher; `orb` speaks your message aloud to the user through the voice orb (use for a short spoken heads-up, e.g. "the deploy is blocked on you") -- the orb prefixes it with your conversation name.',
    {
      to: z
        .union([z.string(), z.array(z.string()).min(1).max(25)])
        .describe(
          'Single target conversation ID/title/agent name, or an array of IDs for multicast (up to 25). For replies, use the from_conversation value from the incoming <channel> wrapper.',
        ),
      message: z
        .string()
        .describe('Message body. Markdown is fine; the recipient sees it inside <channel>...</channel>.'),
      intent: z
        .enum(['request', 'response', 'notification'])
        .optional()
        .describe('request=needs answer, response=replying to them, notification=FYI no answer expected'),
    },
    async ({ to, message, intent }) => {
      const isArrayTarget = Array.isArray(to)
      const targets = (isArrayTarget ? to : [to]).filter(t => typeof t === 'string' && t.length > 0)
      const conversations = conversationStore.getAllConversations()
      const results = await Promise.all(
        targets.map(async t => {
          // RESERVED `dispatcher` SINK (plan B3): a dispatched worker reports its
          // findings back to the user's dispatcher. Intercept BEFORE the normal
          // conversation lookup -- `dispatcher` is not a conversation.
          if (t === 'dispatcher') {
            const res = await deliverDispatcherReport(conversationStore, callerConversationId, message)
            return { to: t, ok: res.ok, status: 'delivered' as const, error: res.ok ? undefined : res.detail }
          }
          // RESERVED `orb` SINK: speak this line aloud to the user through the
          // live voice orb. Like `dispatcher`, it is a system notification, not a
          // peer conversation -- intercept before the lookup and bypass the link
          // gate. Best-effort: `subscribers` reports how many panels heard it.
          const orb = parseOrbTarget(t)
          if (orb.isOrb) {
            const res = relayToOrb(conversationStore, callerConversationId, message, orb.orbId)
            const note =
              res.subscribers > 0
                ? `spoken to the orb (${res.subscribers} listening)`
                : 'no orb is summoned right now -- nobody heard it'
            return { to: t, ok: res.ok, status: 'delivered' as const, note }
          }
          const target = conversations.find(c => c.id === t || c.title === t || c.agentName === t)
          if (!target) {
            return { to: t, ok: false, error: 'Target not found' }
          }
          const ws = conversationStore.getConversationSocket(target.id)
          if (!ws) {
            return { to: t, ok: false, error: 'Target not connected' }
          }
          ws.send(
            JSON.stringify({
              type: 'inter_session_message',
              from: 'mcp-client',
              message,
              intent: intent || 'notification',
            }),
          )
          return { to: t, ok: true, status: 'delivered' as const, targetConversationId: target.id }
        }),
      )

      if (!isArrayTarget) {
        const r = results[0]
        if (!r.ok) {
          const why = r.error ? `: ${r.error}` : ' not found or not connected'
          return { content: [{ type: 'text', text: `Target "${r.to}"${why}` }] }
        }
        const note = (r as { note?: string }).note
        if (note) return { content: [{ type: 'text', text: note }] }
        const dest = r.targetConversationId ?? r.to // `dispatcher` has no conv id
        return { content: [{ type: 'text', text: `Message sent to ${dest}` }] }
      }
      const delivered = results.filter(r => r.ok).length
      const failed = results.length - delivered
      const lines = [`Multicast to ${results.length} target(s): ${delivered} delivered, ${failed} failed.`]
      for (const r of results) {
        const detail = r.ok ? `(target_conversation_id: ${r.targetConversationId})` : `-- ${r.error}`
        lines.push(`  - ${r.to}: ${r.ok ? 'delivered' : 'failed'} ${detail}`)
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    },
  )

  // ─── spawn_conversation ──────────────────────────────────────────────────
  mcp.tool(
    'spawn_conversation',
    'Spawn a new conversation (a fresh Claude Code session or chat-api worker). Use when the user asks to "delegate this", "start a new session", or when a task needs an isolated context. Returns the conversationId so you can send_message to coordinate with it.\n\nSentinel profiles (multi-account fan-out): the optional `profile` / `pool` params pick which sentinel-profile (a separate Claude account / config dir on the host) the worker runs under. `profile` is either a literal profile name (Fixed selection, e.g. "work") or a SelectionMode token ("default" | "balanced" | "random"); "default" is the implicit profile ($HOME/.claude) when omitted. `pool` names a profile subset that constrains Balanced/Random selection. When `profile` is a literal name (Fixed), it wins and `pool` is ignored. ONLY set them if the user explicitly asks for a specific profile or pool ("run on the work profile", "use pool X"); otherwise leave both unset and the sentinel applies its defaultSelection. Discover a sentinel\'s profiles + pools via list_hosts.',
    {
      cwd: z.string().describe('Absolute working directory for the spawned session.'),
      prompt: z.string().optional().describe('Initial user prompt for the spawned agent.'),
      name: z.string().optional().describe('Display name for the conversation (auto-generated if omitted).'),
      model: z.string().optional().describe('Model override. Otherwise uses the project default.'),
      backend: z
        .enum(['claude', 'chat-api'])
        .optional()
        .describe('claude=Claude Code (with tools); chat-api=plain LLM via OpenRouter/etc.'),
      chatConnectionId: z.string().optional().describe('For backend=chat-api, which configured connection to use.'),
      headless: z.boolean().optional().describe('Default true. Headless sessions run without a visible terminal.'),
      profile: z
        .string()
        .optional()
        .describe(
          'Sentinel-profile selection: a literal profile name to pin (Fixed, e.g. "work") or a SelectionMode token ("default" | "balanced" | "random"). Omit to follow the sentinel\'s defaultSelection (the implicit "default" profile = $HOME/.claude). When a literal name is given it wins and `pool` is ignored. ONLY set when the user explicitly asks for a specific profile. Discover names via list_hosts.',
        ),
      pool: z
        .string()
        .optional()
        .describe(
          'Named profile pool that constrains Balanced/Random selection (e.g. "work"). Used together with profile="balanced"|"random"; ignored when `profile` is a literal name (Fixed wins). ONLY set when the user explicitly asks for a pool. Discover pools via list_hosts.',
        ),
    },
    async ({ cwd, prompt, name, model, backend, chatConnectionId, headless, profile, pool }) => {
      const callerContext = {
        kind: 'mcp' as const,
        hasSpawnPermission: true,
        trustLevel: 'trusted' as const,
        callerProject: null,
      }
      // X-Caller-Conversation header is captured by the Hono /mcp handler and
      // closed over here. Passing it as rendezvousCallerConversationId mirrors
      // routes/spawn.ts:33 and inter-conversation.ts:127 -- the rendezvous
      // registry then has caller->child linkage for boot-lifecycle to persist
      // (Phase 2 of plan-spawn-parent-tracking.md). Missing header = undefined,
      // which is the prior behavior (no caller attribution).
      console.log(
        `[spawn-mcp] caller=${callerConversationId ? callerConversationId.slice(0, 8) : 'none'} ` +
          `cwd=${cwd} backend=${backend ?? 'default'} headless=${headless ?? true}`,
      )
      const deps: SpawnDispatchDeps = {
        conversationStore,
        getProjectSettings,
        getGlobalSettings,
        callerContext,
        rendezvousCallerConversationId: callerConversationId ?? null,
      }
      const result = await dispatchSpawn(
        {
          cwd,
          prompt,
          name,
          model,
          backend,
          chatConnectionId,
          headless: headless ?? true,
          profile,
          pool,
        },
        deps,
      )
      if (!result.ok) {
        return { content: [{ type: 'text', text: `Spawn failed: ${result.error}` }], isError: true }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ conversationId: result.conversationId, jobId: result.jobId }),
          },
        ],
      }
    },
  )

  // ─── dispatch (Front Desk routing brain) ─────────────────────────────
  mcp.tool(
    'dispatch',
    'Front Desk dispatcher: hand it an INTENT and it decides the disposition -- spawn a NEW conversation, ROUTE the message into an existing live one, or REVIVE an ended one -- then executes via the existing spawn/route handlers. Returns the structured decision (disposition, target, confidence, reasoning, cost, candidates). Pass only `intent` to let it decide; pass `target`/`disposition` to override. A very-expensive route (large context / cold cache / Opus) is HELD with `awaitingConfirmation` until you re-call with `confirmedExpensive: true`. If unsure it returns disposition `ask` with candidate conversations to choose from. Only projects opted into the dispatcher status feed are considered. A NEW spawn needs `cwd`; with `worktreeName` the worker is placed worktree-correctly (a cwd=main+worktree combo is refused).',
    {
      intent: z.string().describe("What you want done, in the user's words."),
      target: z
        .string()
        .optional()
        .describe('Explicit conversationId or project to force (override-first, no LLM call).'),
      disposition: z.enum(['new', 'route', 'revive']).optional().describe('Hard override of the routing decision.'),
      confirmedExpensive: z
        .boolean()
        .optional()
        .describe('Set true to proceed with a route the dispatcher flagged as very expensive.'),
      cwd: z.string().optional().describe('For a NEW spawn: absolute working directory.'),
      worktreeName: z
        .string()
        .optional()
        .describe('For a NEW spawn: the worktree/branch to place the worker in (worktree-correct).'),
    },
    async ({ intent, target, disposition, confirmedExpensive, cwd, worktreeName }) => {
      try {
        const decision = await runDispatch(
          { intent, target, disposition, confirmedExpensive, cwd, worktreeName },
          { store: conversationStore, callerConversationId },
        )
        return toolText(JSON.stringify(decision))
      } catch (e) {
        return toolText(`dispatch failed: ${(e as Error).message}`, true)
      }
    },
  )

  // ─── list_threads (dispatcher near-memory) ───────────────────────────
  mcp.tool(
    'list_threads',
    "List the dispatcher's threads -- its near-memory of what it is managing right now. Each thread is a tiny local State-of-the-Union: a title + summary + the conversations it has used WITH a last-used timestamp per conversation. This is what the dispatcher remembers.",
    { limit: z.number().int().positive().optional().describe('Max threads (default 50).') },
    async ({ limit }) => toolText(JSON.stringify(listThreads(limit))),
  )

  // ─── list_conversations ─────────────────────────────────────────────
  mcp.tool(
    'list_conversations',
    "List Claudwerk conversations (CC, Hermes, chat-api). Default excludes ended sessions. Pass status:'all' to see the full graveyard. Lineage filters: rootConversationId returns a whole spawn subtree (conv X + everything spawned from it, transitively); parentConversationId returns just direct children of X. The two are mutually exclusive. format:'tree' renders an ASCII spawn tree instead of JSON. Returns conversationId, title, project, status, model, agentHostType, startedAt, lastActivity, parentConversationId, rootConversationId, directChildCount for each row.",
    {
      status: z
        .enum(['active', 'idle', 'ended', 'all'])
        .optional()
        .describe('Filter. Default = active+idle (everything not ended).'),
      rootConversationId: z
        .string()
        .optional()
        .describe(
          'Return the full spawn subtree rooted at this conversationId (inclusive). Mutually exclusive with parentConversationId.',
        ),
      parentConversationId: z
        .string()
        .optional()
        .describe('Return only direct children of this conversationId. Mutually exclusive with rootConversationId.'),
      format: z
        .enum(['json', 'tree'])
        .optional()
        .describe("Output format. 'json' (default) returns a flat array. 'tree' renders an ASCII spawn tree."),
    },
    async ({ status, rootConversationId, parentConversationId, format }) => {
      if (rootConversationId && parentConversationId) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: rootConversationId and parentConversationId are mutually exclusive.',
            },
          ],
          isError: true,
        }
      }
      const all = conversationStore.getAllConversations()
      // directChildCount aggregate: built against the FULL set so a filter
      // (e.g. status='active') still surfaces accurate counts for parents whose
      // children fell outside the filter.
      const childCounts = new Map<string, number>()
      for (const c of all) {
        if (c.parentConversationId) {
          childCounts.set(c.parentConversationId, (childCounts.get(c.parentConversationId) ?? 0) + 1)
        }
      }
      let conversations = all
      if (status && status !== 'all') {
        conversations = conversations.filter(c => c.status === status)
      } else if (!status) {
        conversations = conversations.filter(c => c.status !== 'ended')
      }
      if (rootConversationId) {
        conversations = conversations.filter(
          c => c.id === rootConversationId || c.rootConversationId === rootConversationId,
        )
      } else if (parentConversationId) {
        conversations = conversations.filter(c => c.parentConversationId === parentConversationId)
      }
      const summary = conversations.map(c => ({
        conversationId: c.id,
        title: c.title,
        project: c.project,
        status: c.status,
        model: c.model,
        agentHostType: c.agentHostType,
        startedAt: c.startedAt,
        lastActivity: c.lastActivity,
        parentConversationId: c.parentConversationId,
        rootConversationId: c.rootConversationId,
        directChildCount: childCounts.get(c.id) ?? 0,
      }))
      if (format === 'tree') {
        return { content: [{ type: 'text', text: renderLineageTree(summary) }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
    },
  )

  // ─── project_list ───────────────────────────────────────────────────
  mcp.tool(
    'project_list',
    "List tasks on the user's kanban-style project board. Status columns: inbox, open, in-progress, in-review, done, archived. Each task has id, title, priority, tags, refs.",
    { status: z.string().optional().describe('Filter by column. Omit for all tasks.') },
    async ({ status }) => {
      // Read from project board files
      const tasks = store.kv.get<Record<string, unknown>[]>('project:tasks') || []
      const filtered = status ? tasks.filter(t => t.status === status) : tasks
      return { content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }] }
    },
  )

  // ─── project_set_status ─────────────────────────────────────────────
  mcp.tool(
    'project_set_status',
    'Move a project task between status columns',
    {
      id: z.string().describe('Task ID (filename without .md)'),
      status: z.string().describe('Target status (inbox, open, in-progress, in-review, done, archived)'),
    },
    async ({ id, status: newStatus }) => {
      // Update task status in KV store
      const tasks = store.kv.get<Record<string, unknown>[]>('project:tasks') || []
      const task = tasks.find(t => t.id === id)
      if (!task) {
        return { content: [{ type: 'text', text: `Task "${id}" not found` }], isError: true }
      }
      task.status = newStatus
      store.kv.set('project:tasks', tasks)
      return { content: [{ type: 'text', text: `Task "${id}" moved to ${newStatus}` }] }
    },
  )

  // ─── Web Debug Control (drive a live control-panel browser) ──────────
  // These tools let you operate a REAL connected control-panel browser to
  // debug Claudwerk through its eyes: screenshot it, run command-palette
  // commands, navigate, read the rendered transcript, send a prompt. The
  // browser must OPT IN first (Settings > System > Debug > "Allow agent
  // remote-control"); the grant lasts 1h and survives reload. If no browser
  // is opted-in every call returns an error -- this is default-deny by design.
  // Always start with web_list_clients to see what's available.

  // ─── web_list_clients ────────────────────────────────────────────────
  mcp.tool(
    'web_list_clients',
    'List control-panel browsers that have opted in to agent remote-control. Returns clientId (stable, pass it to the other web_* tools), label, userName, capabilities, and ttlMs (ms left on the 1h grant). Empty list = nobody opted in; ask the user to enable it in Settings > System > Debug. When exactly one client is opted-in you may omit clientId on the other tools and it is used implicitly.',
    {},
    async () => {
      const clients = listWebControlClients()
      if (clients.length === 0) {
        return toolText(
          'No browser is opted-in to remote control. Ask the user to enable "Allow agent remote-control" in the control panel (Settings > System > Debug).',
        )
      }
      return toolText(JSON.stringify(clients, null, 2))
    },
  )

  // ─── web_screenshot ──────────────────────────────────────────────────
  mcp.tool(
    'web_screenshot',
    'Capture a screenshot of the opted-in control-panel browser and return a public image URL (fetch it to view). Optionally pass a CSS `selector` to capture just one element instead of the whole app.',
    {
      clientId: z
        .string()
        .optional()
        .describe('Target browser (from web_list_clients). Omit if exactly one is opted-in.'),
      selector: z
        .string()
        .optional()
        .describe('CSS selector of a single element to capture. Omit to capture the whole viewport.'),
    },
    async ({ clientId, selector }) => runWebControlOp(clientId, 'screenshot', { selector }),
  )

  // ─── web_list_commands ───────────────────────────────────────────────
  mcp.tool(
    'web_list_commands',
    'List the command-palette commands currently registered (and visible) in the opted-in browser. Returns id, label, and group for each. Feed an id into web_execute_command.',
    {
      clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.'),
    },
    async ({ clientId }) => runWebControlOp(clientId, 'list_commands', {}),
  )

  // ─── web_execute_command ─────────────────────────────────────────────
  mcp.tool(
    'web_execute_command',
    'Run a command-palette command in the opted-in browser by its id (discover ids via web_list_commands). Opting in grants full palette access, including destructive commands -- the user authorized this by enabling remote-control.',
    {
      clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.'),
      id: z.string().describe('Command id to execute (from web_list_commands).'),
      args: z.array(z.string()).optional().describe('String arguments passed to the command action.'),
    },
    async ({ clientId, id, args }) => runWebControlOp(clientId, 'execute_command', { id, args: args ?? [] }),
  )

  // ─── web_set_conversation ────────────────────────────────────────────
  mcp.tool(
    'web_set_conversation',
    'Navigate the opted-in browser to a specific conversation (selects it as the active conversation).',
    {
      clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.'),
      conversationId: z.string().describe('Conversation id to select.'),
    },
    async ({ clientId, conversationId }) => runWebControlOp(clientId, 'set_conversation', { conversationId }),
  )

  // ─── web_read_transcript ─────────────────────────────────────────────
  mcp.tool(
    'web_read_transcript',
    "Read the transcript as rendered in the opted-in browser. Defaults to the browser's currently-active conversation; pass conversationId to read a specific one (must be loaded in that browser). format:'text' (default) returns a compact text rendering; format:'json' returns the raw entry array.",
    {
      clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.'),
      conversationId: z
        .string()
        .optional()
        .describe("Conversation to read. Omit for the browser's currently-active conversation."),
      format: z.enum(['text', 'json']).optional().describe("Output format. Default 'text'."),
    },
    async ({ clientId, conversationId, format }) =>
      runWebControlOp(clientId, 'read_transcript', { conversationId, format: format ?? 'text' }),
  )

  // ─── web_send_prompt ─────────────────────────────────────────────────
  mcp.tool(
    'web_send_prompt',
    'Type and send a prompt to a conversation through the opted-in browser (same path as a user typing in the input box, including client-side control verbs like /clear or /model).',
    {
      clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.'),
      conversationId: z.string().describe('Conversation id to send the prompt to.'),
      text: z.string().describe('Prompt text to send.'),
    },
    async ({ clientId, conversationId, text }) => runWebControlOp(clientId, 'send_prompt', { conversationId, text }),
  )

  // ─── Host-shell terminals (driven detached / off-screen) ─────────────
  // The opted-in browser drives host shells in the background: an agent-
  // attached shell renders OFF-SCREEN (mounted, subscribed, readable) and never
  // pops the fullscreen overlay, so the user's view is never hijacked. Shells
  // started via web_terminal_start get a "[debug] " title prefix. Typical flow:
  // web_terminal_start (or web_terminal_attach an existing shellId) -> wait a
  // beat -> web_terminal_read / web_terminal_write -> web_terminal_detach.

  // ─── web_terminal_list ───────────────────────────────────────────────
  mcp.tool(
    'web_terminal_list',
    'List host shells visible to the opted-in browser. Returns shellId, title, path, projectUri, status, agentAttached (driven by you, off-screen) and readable (has a live buffer you can read now). Start a new one with web_terminal_start or attach an existing one with web_terminal_attach.',
    { clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.') },
    async ({ clientId }) => runWebControlOp(clientId, 'terminal_list', {}),
  )

  // ─── web_terminal_start ──────────────────────────────────────────────
  mcp.tool(
    'web_terminal_start',
    'Open a NEW host shell in the given project and attach to it detached (off-screen, never pops the overlay). Title is prefixed "[debug] ". Returns shellId. After ~1.5s the buffer is ready for web_terminal_read. projectUri is claude://sentinel/path -- discover via list_hosts / list_conversations.',
    {
      clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.'),
      projectUri: z.string().describe('claude://sentinel/path -- where to run the shell.'),
      title: z.string().optional().describe('Label (will be prefixed "[debug] ").'),
    },
    async ({ clientId, projectUri, title }) => runWebControlOp(clientId, 'terminal_start', { projectUri, title }),
  )

  // ─── web_terminal_attach ─────────────────────────────────────────────
  mcp.tool(
    'web_terminal_attach',
    "Attach to an EXISTING host shell (by shellId from web_terminal_list) detached/off-screen so you can read and write it without taking over the user's screen. Wait ~1.5s after attaching before web_terminal_read.",
    {
      clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.'),
      shellId: z.string().describe('Shell to attach (from web_terminal_list).'),
    },
    async ({ clientId, shellId }) => runWebControlOp(clientId, 'terminal_attach', { shellId }),
  )

  // ─── web_terminal_detach ─────────────────────────────────────────────
  mcp.tool(
    'web_terminal_detach',
    'Detach from a host shell (unmounts the off-screen pane / unsubscribes). The shell keeps running; you just stop reading it.',
    {
      clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.'),
      shellId: z.string().describe('Shell to detach.'),
    },
    async ({ clientId, shellId }) => runWebControlOp(clientId, 'terminal_detach', { shellId }),
  )

  // ─── web_terminal_read ───────────────────────────────────────────────
  mcp.tool(
    'web_terminal_read',
    "Read a host shell's terminal buffer (scrollback + viewport) as plain text. The shell must be attached first (web_terminal_start / web_terminal_attach). Capped to the last maxLines rows (default 2000).",
    {
      clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.'),
      shellId: z.string().describe('Shell to read.'),
      maxLines: z.number().optional().describe('Cap on rows returned (default 2000, from the bottom).'),
    },
    async ({ clientId, shellId, maxLines }) => runWebControlOp(clientId, 'terminal_read', { shellId, maxLines }),
  )

  // ─── web_terminal_write ──────────────────────────────────────────────
  mcp.tool(
    'web_terminal_write',
    'Write raw bytes to a host shell (keystrokes / input). Text is sent EXACTLY as given -- append "\\n" (or "\\r") yourself to submit a command. Control chars work too (e.g. "\\x03" for Ctrl-C). The shell need not be attached to write, but attach to read the result.',
    {
      clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.'),
      shellId: z.string().describe('Shell to write to.'),
      data: z.string().describe('Raw bytes to send. Include the trailing newline to submit.'),
    },
    async ({ clientId, shellId, data }) => runWebControlOp(clientId, 'terminal_write', { shellId, data }),
  )

  // ─── web_terminal_screenshot ─────────────────────────────────────────
  mcp.tool(
    'web_terminal_screenshot',
    "Screenshot a host shell's terminal surface and return a public image URL. The shell must be attached first. Usually web_terminal_read (text) is more useful; use this for TUIs / rendering issues.",
    {
      clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.'),
      shellId: z.string().describe('Shell to screenshot.'),
    },
    async ({ clientId, shellId }) => runWebControlOp(clientId, 'terminal_screenshot', { shellId }),
  )

  // ─── web_set_perf_monitor ────────────────────────────────────────────
  mcp.tool(
    'web_set_perf_monitor',
    'Turn the control-panel performance monitor (the "Details for Nerds" perf HUD) ON or OFF in the opted-in browser. It is OFF by default and records nothing until enabled. Turn it ON, ask the user to reproduce the slow activity (switch conversations, stream a turn, etc.), THEN call web_perf_report. Turn it OFF when done -- the Profiler wrappers add per-commit overhead while on.',
    {
      clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.'),
      enabled: z.boolean().describe('true = start recording, false = stop and clear the ring buffer.'),
    },
    async ({ clientId, enabled }) => runWebControlOp(clientId, 'set_perf_monitor', { enabled }),
  )

  // ─── web_perf_report ─────────────────────────────────────────────────
  mcp.tool(
    'web_perf_report',
    'Grab the performance report from the opted-in browser as markdown: a per-category Summary (count/avg/p95/max), a By-message impact rollup (apply vs render vs paint vs grouping cost per wire-message type), and a chronological Timeline of perf samples interleaved with debug-log lines. Requires the perf monitor to be ON (web_set_perf_monitor {enabled:true}) and some activity to have occurred since. See docs/perf-monitor.md for what each metric means.',
    {
      clientId: z.string().optional().describe('Target browser. Omit if exactly one is opted-in.'),
      significantOnly: z
        .boolean()
        .optional()
        .describe('Only include samples >= 2.5ms in By-message + Timeline (cuts sub-ms noise). Default false.'),
    },
    async ({ clientId, significantOnly }) =>
      runWebControlOp(clientId, 'perf_report', { significantOnly: significantOnly ?? false }),
  )

  return mcp
}

export function createMcpRouter(
  conversationStore: ConversationStore,
  store: StoreDriver,
  _rclaudeSecret?: string,
): Hono {
  const app = new Hono()

  // Stateless mode: no session tracking, JSON responses (no SSE).
  // Tools are pure request/response with no server-initiated notifications,
  // so we don't need session state or long-lived SSE streams. Stateful mode
  // would force clients to open a standalone GET SSE stream that the server
  // never writes to, causing client-side read timeouts (~5min) that kill the
  // anyio TaskGroup and break subsequent tool calls. See Hermes incident
  // 2026-05-10: "MCP server 'claudwerk' connection lost ... unhandled errors
  // in a TaskGroup".
  app.all('/mcp', async c => {
    const authHeader = c.req.header('authorization')
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!bearer) {
      return c.json({ error: 'Authorization required' }, 401)
    }
    const auth = resolveAuth(bearer)
    if (auth.role === 'none') {
      return c.json({ error: 'Invalid token' }, 403)
    }

    // X-Caller-Conversation lets an MCP client identify which of its
    // conversations is initiating a tool call (today this matters for
    // spawn_conversation -- the rendezvous registry uses it to link
    // parent/child for Phase 2 persistence of plan-spawn-parent-tracking.md).
    // Mirrors routes/spawn.ts:33. Missing = undefined = unattributed spawn
    // (old clients still work).
    const callerConversationId = c.req.header('X-Caller-Conversation') ?? null
    const mcp = createMcpServer(conversationStore, store, callerConversationId)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })

    try {
      await mcp.connect(transport)
      return await transport.handleRequest(c.req.raw)
    } finally {
      await transport.close().catch(() => {})
      await mcp.close().catch(() => {})
    }
  })

  return app
}
