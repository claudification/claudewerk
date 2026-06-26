/**
 * The canonical rclaude MCP tool catalog -- the single source of truth for which
 * tools exist across the project's MCP surface and WHERE each is meant to be
 * exposed.
 *
 * Two binding sites exist (see plan-mcp-toolset-unification.md):
 *   - broker : the external MCP server (src/broker/routes/mcp-server.ts, `/mcp`)
 *              that chat-api / opencode / acp / external clients connect to.
 *   - host   : the agent-host MCP server (src/agent-host-common/mcp-host/) that
 *              the in-process agent talks to. Served by BOTH the claude host
 *              (claude-agent-host/local-server.ts) AND -- as of Phase 3c -- the
 *              daemon host (daemon-agent-host/mcp-server.ts); both stand it up
 *              from the one shared `registerAllTools`, so the `host` site is a
 *              single canonical toolset regardless of which host serves it.
 *
 * Every tool a site exposes MUST appear here, and every catalog tool MUST be
 * bound at each of its intended `sites` -- or be listed in DEFERRED_BINDINGS
 * with a reason. The parity test (catalog.parity.test.ts) fails the build on any
 * drift. This is the gate that would have caught `web_*` shipping to the broker
 * but never reaching the host.
 *
 * This file is pure data: it imports nothing from either binding site, so it
 * stays a leaf module that both sites (and the test) can read freely.
 */

export type McpSite = 'broker' | 'host'

export interface CatalogTool {
  name: string
  /** One-line purpose. Canonical identity for drift visibility; not (yet) the
   *  string the servers serve -- those still live at the impl sites. */
  summary: string
  group:
    | 'core'
    | 'project'
    | 'conversation'
    | 'identity'
    | 'hosts'
    | 'files'
    | 'dialog'
    | 'recap'
    | 'sotu'
    | 'web-control'
    | 'nightshift'
    | 'dispatch'
  /** Sites where this tool is MEANT to be exposed. */
  sites: readonly McpSite[]
}

const BOTH = ['broker', 'host'] as const
const HOST_ONLY = ['host'] as const
const BROKER_ONLY = ['broker'] as const

export const MCP_CATALOG: readonly CatalogTool[] = [
  // ── dispatch (Front Desk, broker only) ─────────────────────────────
  { name: 'dispatch', group: 'dispatch', sites: BROKER_ONLY, summary: 'Route an intent: spawn / route / revive' },
  { name: 'list_threads', group: 'dispatch', sites: BROKER_ONLY, summary: "Dispatcher's near-memory threads" },

  // ── core (both sites) ──────────────────────────────────────────────
  { name: 'notify', group: 'core', sites: BOTH, summary: "Push notification to the user's devices" },
  {
    name: 'set_status',
    group: 'core',
    sites: HOST_ONLY,
    summary: 'Report this conversation’s task state for the attention overview',
  },
  { name: 'send_message', group: 'core', sites: BOTH, summary: 'Send a message to other conversations' },
  { name: 'spawn_conversation', group: 'core', sites: BOTH, summary: 'Spawn a new conversation' },
  { name: 'search_transcripts', group: 'core', sites: BOTH, summary: 'FTS5 search across transcripts' },
  { name: 'get_transcript_context', group: 'core', sites: BOTH, summary: 'Transcript window around a seq' },

  // ── project board (both sites) ─────────────────────────────────────
  { name: 'project_list', group: 'project', sites: BOTH, summary: 'List project-board tasks' },
  { name: 'project_set_status', group: 'project', sites: BOTH, summary: 'Move a task between columns' },

  // ── conversation control ───────────────────────────────────────────
  { name: 'list_conversations', group: 'conversation', sites: BOTH, summary: 'List conversations' },
  {
    name: 'control_conversation',
    group: 'conversation',
    sites: HOST_ONLY,
    summary: 'Clear/quit/interrupt/set-model another conversation',
  },
  {
    name: 'configure_conversation',
    group: 'conversation',
    sites: HOST_ONLY,
    summary: "Set a conversation's label/icon/color/keyterms",
  },
  { name: 'rename_conversation', group: 'conversation', sites: HOST_ONLY, summary: 'Rename a conversation' },
  { name: 'exit_conversation', group: 'conversation', sites: HOST_ONLY, summary: 'End the current conversation' },
  { name: 'get_spawn_diagnostics', group: 'conversation', sites: HOST_ONLY, summary: 'Diagnostics for a spawn job' },

  // ── identity (host-local) ──────────────────────────────────────────
  { name: 'whoami', group: 'identity', sites: HOST_ONLY, summary: "This conversation's identity + environment" },
  { name: 'check_update', group: 'identity', sites: HOST_ONLY, summary: 'Check for an rclaude update' },
  { name: 'toggle_plan_mode', group: 'identity', sites: HOST_ONLY, summary: 'Toggle plan mode for this conversation' },

  // ── hosts / files / dialog (host-local) ────────────────────────────
  { name: 'list_hosts', group: 'hosts', sites: HOST_ONLY, summary: 'List connected sentinels + profiles/pools' },
  { name: 'share_file', group: 'files', sites: HOST_ONLY, summary: 'Upload a local file, return a public URL' },
  { name: 'dialog', group: 'dialog', sites: HOST_ONLY, summary: 'Show an interactive dialog and await a response' },
  {
    name: 'dialog_taxonomy',
    group: 'dialog',
    sites: HOST_ONLY,
    summary: 'Index-first docs for authoring dialog block DSLs',
  },
  { name: 'update_dialog', group: 'dialog', sites: HOST_ONLY, summary: 'Patch a live (persistent) dialog in place' },
  {
    name: 'close_dialog',
    group: 'dialog',
    sites: HOST_ONLY,
    summary: 'Close a live (persistent) dialog (terminal but reopenable)',
  },
  {
    name: 'reopen_dialog',
    group: 'dialog',
    sites: HOST_ONLY,
    summary: 'Reopen a previously-closed live (persistent) dialog',
  },

  // ── nightshift (host) ─────────────────────────────────────────────
  {
    name: 'nightshift',
    group: 'nightshift',
    sites: HOST_ONLY,
    summary: 'Write the NIGHTSHIFT morning report for an unattended night run',
  },

  // ── recap (host) ───────────────────────────────────────────────────
  { name: 'recap_create', group: 'recap', sites: HOST_ONLY, summary: 'Create a period recap' },
  { name: 'recap_get', group: 'recap', sites: HOST_ONLY, summary: 'Get a recap document' },
  { name: 'recap_list', group: 'recap', sites: HOST_ONLY, summary: 'List recaps' },
  { name: 'recap_regenerate', group: 'recap', sites: HOST_ONLY, summary: 'Regenerate a recap' },
  { name: 'recap_search', group: 'recap', sites: HOST_ONLY, summary: 'Search recaps' },
  { name: 'recap_templates', group: 'recap', sites: HOST_ONLY, summary: 'List recap templates + their options' },

  // ── sotu / state of the union (host) ───────────────────────────────
  {
    name: 'get_state_of_union',
    group: 'sotu',
    sites: HOST_ONLY,
    summary: 'Read the project State of the Union briefing',
  },
  {
    name: 'sotu_contribute',
    group: 'sotu',
    sites: HOST_ONLY,
    summary: 'Contribute a declared-intent signal to the SOTU',
  },
  {
    name: 'sotu_configure',
    group: 'sotu',
    sites: HOST_ONLY,
    summary: 'Read/tune a project SOTU config (enabled, stakes, budget, distill params)',
  },
  {
    name: 'sotu_eval',
    group: 'sotu',
    sites: HOST_ONLY,
    summary: 'List recent SOTU distill evals (recipe + cost + grounding) for QC',
  },

  // ── web control (both sites; host bridged in Phase 5) ──────────────
  { name: 'web_list_clients', group: 'web-control', sites: BOTH, summary: 'List opted-in control-panel browsers' },
  { name: 'web_screenshot', group: 'web-control', sites: BOTH, summary: 'Screenshot the opted-in browser' },
  { name: 'web_list_commands', group: 'web-control', sites: BOTH, summary: 'List command-palette commands' },
  { name: 'web_execute_command', group: 'web-control', sites: BOTH, summary: 'Run a command-palette command' },
  {
    name: 'web_set_conversation',
    group: 'web-control',
    sites: BOTH,
    summary: 'Navigate the browser to a conversation',
  },
  {
    name: 'web_read_transcript',
    group: 'web-control',
    sites: BOTH,
    summary: 'Read the transcript as the browser renders it',
  },
  { name: 'web_send_prompt', group: 'web-control', sites: BOTH, summary: 'Send a prompt via the browser' },
  { name: 'web_terminal_list', group: 'web-control', sites: BOTH, summary: 'List host shells visible to the browser' },
  { name: 'web_terminal_start', group: 'web-control', sites: BOTH, summary: 'Open + attach a host shell off-screen' },
  {
    name: 'web_terminal_attach',
    group: 'web-control',
    sites: BOTH,
    summary: 'Attach an existing host shell off-screen',
  },
  { name: 'web_terminal_detach', group: 'web-control', sites: BOTH, summary: 'Detach from a host shell' },
  { name: 'web_terminal_read', group: 'web-control', sites: BOTH, summary: "Read a host shell's buffer" },
  { name: 'web_terminal_write', group: 'web-control', sites: BOTH, summary: 'Write bytes to a host shell' },
  { name: 'web_terminal_screenshot', group: 'web-control', sites: BOTH, summary: "Screenshot a host shell's surface" },
  { name: 'web_set_perf_monitor', group: 'web-control', sites: BOTH, summary: 'Toggle the perf monitor on/off' },
  { name: 'web_perf_report', group: 'web-control', sites: BOTH, summary: 'Grab the perf report as markdown' },
  // HOST_ONLY: arbitrary JS eval is benevolent-gated at the host relay; never
  // exposed on the external broker MCP site.
  {
    name: 'web_execute_script',
    group: 'web-control',
    sites: HOST_ONLY,
    summary: 'Run JS in the opted-in browser (separate consent, benevolent-only)',
  },
]

export const CATALOG_NAMES: ReadonlySet<string> = new Set(MCP_CATALOG.map(t => t.name))

export interface DeferredBinding {
  site: McpSite
  name: string
  reason: string
}

/**
 * Tools that a site is MEANT to expose (per `sites`) but does not bind YET.
 * Every gap must be listed here with a reason -- a silent gap is a test failure.
 * Removing an entry without binding the tool re-fails the test (stale defer).
 *
 * Empty as of Phase 5 (plan-web-control-host-bridge.md): the web-control group is
 * now bound at BOTH sites (host via web_control_relay -> broker), so there are no
 * remaining deferred gaps.
 */
export const DEFERRED_BINDINGS: readonly DeferredBinding[] = []
