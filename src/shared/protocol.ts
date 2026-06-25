/**
 * WebSocket Protocol Types
 * Defines the message format between agent host and broker
 */

import type { JobRecord } from './cc-daemon/types'
import type { DialogOp, DialogSnapshot } from './dialog-live'
import type { DialogLayout, DialogResult } from './dialog-schema'
import type {
  NightshiftBlocked,
  NightshiftConfig,
  NightshiftFinalizeInput,
  NightshiftReportInput,
  NightshiftRun,
  NightshiftRunSnapshot,
  NightshiftRunStartInput,
  NightshiftSkipped,
  NightshiftTaskMeta,
  NightshiftTaskPatchInput,
} from './nightshift-types'
import type { ProjectTask, ProjectTaskManifestEntry, ProjectTaskMeta, ProjectTaskRef } from './project-task-types'
import type { SpawnRequest } from './spawn-schema'

export type { LaunchProfile } from './launch-profile'

/**
 * Wire protocol version.
 *
 * Bumped to 2 on 2026-05-04 with the session->conversation rename. Old
 * agent hosts (v1) sent `sessionId` where v2 expects `ccSessionId`.
 *
 * Bumped to 3 on 2026-05-11 with the second-wave session->conversation
 * purge: InterSession* -> InterConversation*, targetSession/fromSession ->
 * targetConversation/fromConversation, session_connected launch step ->
 * conversation_connected, sessionName/sessionDescription ->
 * conversationName/conversationDescription, channel XML wire
 * `from_session` -> `from_conversation`, MCP tool catalog rename
 * (spawn_session etc), and HTTP header X-Session-Id -> X-Conversation-Id.
 *
 * The broker rejects any meta/agent_host_boot with a missing or older
 * version field, replies with a `protocol_upgrade_required` message naming
 * the current version + a copy-pastable upgrade command, and broadcasts an
 * `agent_host_outdated` toast so dashboards can surface the issue.
 *
 * Bump this any time a wire-level breaking change ships -- field renames,
 * removals, or incompatible value changes. The broker assumes the latest
 * version it knows about; any client below it gets rejected.
 */
export const AGENT_HOST_PROTOCOL_VERSION = 3

// Control Panel -> Broker: spawn request (WS equivalent of POST /api/spawn)
export type SpawnRequestMessage = { type: 'spawn_request' } & SpawnRequest

// Broker -> Control Panel: ack for spawn_request (correlated by jobId)
export interface SpawnRequestAck {
  type: 'spawn_request_ack'
  ok: boolean
  jobId?: string
  conversationId?: string
  tmuxSession?: string
  error?: string
}

// Agent Host -> Broker messages
export interface HookEvent {
  type: 'hook'
  conversationId: string
  hookEvent: HookEventType
  timestamp: number
  data: HookEventData
  /** Subagent attribution stamped by the agent host. In the current CC version
   *  EVERY subagent (Task tool) hook carries the PARENT session id and no
   *  subagent identifier, so the broker cannot tell subagent hooks apart from
   *  the wire payload alone. The agent host -- which brackets each subagent
   *  between SubagentStart/SubagentStop -- tags subagent-originated hooks with
   *  the running subagent's agent_id here. Presence of this field means
   *  "this hook came from a subagent, NOT the parent": the broker routes it to
   *  the subagent's event bucket and MUST NOT apply parent-level side effects
   *  (status flip, model write, compaction state). Absent = parent-originated.
   *  Value is the SubagentStart `agent_id` (matches the conv.subagents roster
   *  key); with multiple subagents in flight it is the most-recently-started
   *  one (containment over exact attribution -- see
   *  plan-subagent-hook-containment.md). NOT to be confused with the
   *  CC-controlled `data.conversation_id`, which we never overload. */
  subagentId?: string
}

// Capabilities that rclaude declares on connect
export type AgentHostCapability =
  | 'terminal'
  | 'channel'
  | 'headless'
  | 'json_stream'
  | 'ad-hoc'
  | 'boot_stream'
  | 'repl'
  | 'config_rw'

/** Discrete lifecycle steps the agent host reports while booting, before CC
 *  has a real session id. Rendered inline in the transcript as BootEntry. */
export type BootStep =
  | 'agent_host_started'
  | 'settings_merged'
  | 'mcp_prepared'
  | 'broker_connected'
  | 'claude_spawning'
  | 'claude_started'
  | 'awaiting_init'
  | 'init_received'
  | 'conversation_ready'
  | 'claude_exited'
  | 'boot_error'

export interface ConversationMeta {
  type: 'meta'
  /** Wire protocol version this client speaks. See AGENT_HOST_PROTOCOL_VERSION. */
  protocolVersion: number
  ccSessionId: string
  conversationId: string // stable identity that survives /clear, reconnect, and revival
  project: string
  startedAt: number
  model?: string
  configuredModel?: string // the --model value passed to CC (CC strips [1m] from API responses)
  args?: string[]
  capabilities?: AgentHostCapability[]
  version?: string
  buildTime?: string
  agentHostType?: string
  claudeVersion?: string
  claudeAuth?: {
    email?: string
    orgId?: string
    orgName?: string
    subscriptionType?: string
  }
  spinnerVerbs?: string[]
  autocompactPct?: number // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value if set
  maxBudgetUsd?: number // --max-budget-usd value if set (headless only)
  adHocTaskId?: string // project board task slug that spawned this ad-hoc conversation
  adHocWorktree?: string // worktree branch name for ad-hoc conversations
}

export interface ConversationEnd {
  type: 'end'
  conversationId: string
  ccSessionId?: string
  /** Free-form reason from agent host. Kept for compat. Prefer `source`. */
  reason: string
  /** Typed termination source (defined later in this file). */
  source?: TerminationSource
  detail?: TerminationDetail
  endedAt: number
}

// Agent host tells broker to wipe ephemeral state (e.g. /clear).
// conversationId is stable -- CC session ID transitions are internal to the agent host.
export interface ConversationReset {
  type: 'conversation_reset'
  conversationId: string
  project: string
  model?: string
}

// Upsert opaque metadata on a conversation. The broker stores it without interpreting it.
// Used by agent host type 'claude' to persist ccSessionId (needed for revival via --resume)
// and by the sentinel for any host-specific state.
export interface UpdateConversationMetadata {
  type: 'update_conversation_metadata'
  conversationId: string
  metadata: Record<string, unknown>
}

export interface Heartbeat {
  type: 'heartbeat'
  conversationId: string
  timestamp: number
}

// Terminal streaming messages (browser <-> broker <-> rclaude)
// All terminal messages route by conversationId (stable conversation identity)
export interface TerminalAttach {
  type: 'terminal_attach'
  conversationId: string
  cols: number
  rows: number
}

export interface TerminalDetach {
  type: 'terminal_detach'
  conversationId: string
}

export interface TerminalData {
  type: 'terminal_data'
  conversationId: string
  data: string
}

export interface TerminalResize {
  type: 'terminal_resize'
  conversationId: string
  cols: number
  rows: number
}

export interface TerminalError {
  type: 'terminal_error'
  conversationId: string
  error: string
}

// ---------------------------------------------------------------------------
// Host shell messages (browser <-> broker <-> sentinel)
//
// A host shell is a raw `$SHELL` PTY owned by the SENTINEL, addressed by the
// project URI `claude://{sentinel}/{path}` + a `shellId`. Floating, global,
// permission-filtered by URI. Three planes:
//   - Roster  (broker -> web): what shells exist + activity blink. No bytes.
//   - Control (broker <-> sentinel): spawn / kill / exit.
//   - Data    (sentinel <-> broker <-> web): PTY bytes, lazy per-viewer.
// All shell routing keys are projectUri / sentinelId / shellId -- NEVER
// ccSessionId (broker boundary). See plan-host-shell.md.
// ---------------------------------------------------------------------------

/** A single floating host shell, as advertised on the global roster. The roster
 *  is broadcast to every permitted web client, filtered per-client by URI
 *  access. Carries NO PTY bytes -- purely the "what exists" fact. */
export interface ShellRosterEntry {
  shellId: string
  /** `claude://{sentinel}/{path}` -- the permission boundary + addressing key. */
  projectUri: string
  sentinelId: string
  /** Working directory the shell runs in (= URI path / project root). */
  path: string
  /** Display title (defaults to basename(path) or user-supplied). */
  title: string
  status: 'live' | 'exited'
  /** Identity (user name) that opened the shell. */
  createdBy: string
  createdAt: number
}

// --- Roster plane: broker -> web (permission-filtered per client) ---

/** Full roster snapshot on web connect / resync. Filtered per client by URI. */
export interface ShellRoster {
  type: 'shell_roster'
  shells: ShellRosterEntry[]
}

/** A shell opened that this client is permitted to see. */
export interface ShellAdded {
  type: 'shell_added'
  shell: ShellRosterEntry
}

/** A shell died / was killed / its sentinel went offline. */
export interface ShellRemoved {
  type: 'shell_removed'
  shellId: string
  /** PTY exit code when known (absent on sentinel-disconnect cleanup). */
  code?: number
}

/** Throttled activity blink (coalesced ~4/sec max per shell). Drives the
 *  top-bar activity light WITHOUT subscribing to bytes. Emitted sentinel ->
 *  broker over the control WS, then rebroadcast broker -> roster subscribers. */
export interface ShellActivity {
  type: 'shell_activity'
  shellId: string
  ts: number
}

// --- Data plane: lazy per-viewer subscription (dedicated shell-data WS) ---

/** Expand a shell tile == subscribe. Broker perm-checks URI read access, adds
 *  the viewer, triggers ring-buffer replay, starts byte forwarding. cols/rows
 *  feed the tmux-style min-size policy. (web -> broker) */
export interface ShellSubscribe {
  type: 'shell_subscribe'
  shellId: string
  cols: number
  rows: number
}

/** Minimize / detach-close == unsubscribe. Drops the viewer; bytes stop; the
 *  roster tile + activity light remain. (web -> broker) */
export interface ShellUnsubscribe {
  type: 'shell_unsubscribe'
  shellId: string
}

/** PTY output. Broker fans out to subscribed viewers only.
 *  (sentinel -> broker -> subscribed web) */
export interface ShellData {
  type: 'shell_data'
  shellId: string
  data: string
}

/** Keystrokes. Broker perm-checks URI WRITE access before forwarding.
 *  (web -> broker -> sentinel) */
export interface ShellInput {
  type: 'shell_input'
  shellId: string
  data: string
}

/** Per-viewer desired size. Sentinel applies the min-size policy across all
 *  current subscribers. (web -> broker -> sentinel) */
export interface ShellResize {
  type: 'shell_resize'
  shellId: string
  cols: number
  rows: number
}

/** Ring-buffer dump on subscribe. The client clears + repaints on this. `done`
 *  marks the final chunk. (sentinel -> broker -> one web) */
export interface ShellReplay {
  type: 'shell_replay'
  shellId: string
  data: string
  done: boolean
}

/** First viewer subscribed: the broker tells the sentinel to start forwarding
 *  live `shell_data` for this shell and (when `replay`) to dump the ring buffer
 *  as `shell_replay` first. `cols`/`rows` are the broker-computed min-size
 *  across all current viewers (the broker owns the per-viewer size map because
 *  viewer identity only exists at the broker; the sentinel applies the
 *  authoritative size verbatim -- see plan-host-shell.md 4.1). The sentinel
 *  buffers PTY output into the ring at all times, but only streams while
 *  attached, honoring "no bytes until expanded" (0.1). (broker -> sentinel) */
export interface ShellAttach {
  type: 'shell_attach'
  shellId: string
  cols: number
  rows: number
  replay: boolean
}

/** Last viewer unsubscribed: the broker tells the sentinel to stop forwarding
 *  live `shell_data`. The PTY keeps running (floating) and the ring buffer
 *  keeps filling; only the stream pauses. (broker -> sentinel) */
export interface ShellDetach {
  type: 'shell_detach'
  shellId: string
}

// --- Control plane: sentinel-targeted (existing sentinel control WS) ---

/** Open a shell. Broker perm-checks URI WRITE access, routes to the sentinel
 *  derived from `projectUri`. `conversationId` is UI-grouping + transcript
 *  attachment only -- the shell is NOT owned by the conversation.
 *  (web -> broker -> sentinel) */
export interface ShellOpen {
  type: 'shell_open'
  projectUri: string
  shellId: string
  cols: number
  rows: number
  title?: string
  conversationId?: string
}

/** Kill a shell. Broker perm-checks URI WRITE access, routes to the sentinel.
 *  (web -> broker -> sentinel) */
export interface ShellClose {
  type: 'shell_close'
  shellId: string
}

/** PTY exited. Broker -> `shell_removed` on the roster; also emits a
 *  `TranscriptShellEntry` when a `conversationId` was attached at open.
 *  (sentinel -> broker) */
export interface ShellExit {
  type: 'shell_exit'
  shellId: string
  code: number
}

/** One live shell in a `shell_resync` snapshot. Mirrors the fields the broker
 *  needs to rebuild a `ShellRosterEntry` it lost (it supplies `sentinelId` from
 *  the resyncing connection + `status: 'live'`). */
export interface ShellResyncEntry {
  shellId: string
  projectUri: string
  path: string
  title: string
  createdBy: string
  createdAt: number
}

/**
 * Sentinel -> broker (control WS): the sentinel's FULL live host-shell roster,
 * sent on every control-WS (re)connect. The broker reconciles its in-memory
 * roster to this authoritative snapshot -- re-adding shells it lost on restart,
 * pruning ones that died while the control WS was down. This is what makes host
 * shells survive a broker restart: the PTYs keep running on the sentinel, and
 * resync resurfaces them. Keyed by the stable `machineId` (the data-WS pairing
 * key, which survives a sentinelId rekey across reconnects).
 */
export interface ShellResync {
  type: 'shell_resync'
  machineId: string
  shells: ShellResyncEntry[]
}

/**
 * Sentinel -> broker (control WS): a single host shell the sentinel ORIGINATED
 * itself (a host-side `sentinel shell` invocation, not a broker `shell_open`).
 * The broker builds the `ShellRosterEntry` (sentinelId + machineId from the
 * connection, `status: 'live'`) and broadcasts `shell_added` -- the back half of
 * the `shell_open` path minus the broker-side write pre-check (the shell is born
 * on the host; roster visibility is still gated per-URI on the read side). The
 * shell also rides the next `shell_resync` since it lives in the sentinel's
 * registry from the moment it spawns.
 */
export interface ShellOriginated {
  type: 'shell_originated'
  shellId: string
  projectUri: string
  path: string
  title: string
  createdBy: string
  createdAt: number
}

export interface DiagLog {
  type: 'diag'
  conversationId: string
  entries: Array<{ t: number; type: string; msg: string; args?: unknown }>
}

export interface TasksUpdate {
  type: 'tasks_update'
  conversationId: string
  tasks: TaskInfo[]
}

/**
 * Dashboard -> broker: mark every active todo (kind='todo' AND status != 'completed')
 * as done. Useful when a conversation has disconnected and the user wants to clear
 * the visible task badge. The agent host (if connected) is NOT involved -- the broker
 * mutates its own task records and broadcasts. On reconnect, the agent host's view
 * is authoritative and may reintroduce tasks.
 */
export interface MarkAllTasksDone {
  type: 'mark_all_tasks_done'
  conversationId: string
}

// Transcript streaming: rclaude -> broker
export interface TranscriptEntries {
  type: 'transcript_entries'
  conversationId: string
  entries: TranscriptEntry[]
  isInitial: boolean // true for initial batch on connect, false for incremental
}

export interface SubagentTranscript {
  type: 'subagent_transcript'
  conversationId: string
  agentId: string
  entries: TranscriptEntry[]
  isInitial: boolean
}

export interface FileResponse {
  type: 'file_response'
  requestId: string
  data?: string // base64
  mediaType?: string
  error?: string
}

// Content block in a Claude API message (text, tool_use, tool_result, thinking)
//
// Tool blocks (tool_use, tool_result) carry both LEGACY fields (name/input/
// content -- Claude API shape, kept for backward compat with persisted
// transcripts) and CANONICAL fields (kind/canonicalInput/raw/result --
// CLAUDEWERK's agnostic vocabulary, populated by every agent host's
// dialect translator). See `src/shared/tool-vocab.ts` for the vocab and
// `.claude/docs/plan-fabric.md` for the rationale.
//
// New emissions MUST populate the canonical fields. Old persisted entries
// won't have them; readers that need agnostic data can derive it via the
// `legacyToCanonical` shim (Phase 5 of the dialect-translation rollout).
export interface TranscriptContentBlock {
  type: string // 'text' | 'tool_use' | 'thinking' | 'tool_result' | ...
  text?: string
  thinking?: string
  signature?: string
  // ----- legacy Claude-API fields (still populated as derived aliases) -----
  name?: string
  id?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | unknown
  is_error?: boolean
  // ----- canonical CLAUDEWERK fields (new emissions only) -----
  /** Canonical agnostic tool kind, e.g. 'file.read', 'shell.exec',
   *  'mcp.claudewerk.notify'. See ToolKind in src/shared/tool-vocab.ts. */
  kind?: string
  /** Canonical tool input keyed by the canonical-kind input shape (see
   *  ToolKindInputs in src/shared/tool-vocab.ts). Distinct from `input`
   *  (legacy Claude-API shape with the original backend's keys). */
  canonicalInput?: Record<string, unknown>
  /** Canonical tool result envelope. See ToolResult in tool-vocab.ts. */
  result?: { kind: string; [k: string]: unknown }
  /** Origin payload, NEVER lost in translation. For tool_use this carries
   *  { backend, name, input }; for tool_result { backend, content, isError? }.
   *  See ToolOrigin / ToolResultOrigin in src/shared/tool-vocab.ts. */
  raw?: { backend: string; [k: string]: unknown }
}

// Common fields present on most JSONL transcript entries
interface TranscriptEntryBase {
  type: string
  timestamp?: string
  uuid?: string
  parentUuid?: string | null
  isSidechain?: boolean
  ccSessionId?: string
  cwd?: string
  version?: string
  gitBranch?: string
  slug?: string
  userType?: string
  /** Per-conversation monotonic sequence number, stamped by the broker on cache
   *  insert. Starts at 1, increments by 1 per entry within a conversation. Scoped to
   *  the broker's in-memory counter -- NOT persisted to JSONL. On restart
   *  the counter rebuilds from hydration and SYNC_EPOCH bumps, forcing clients
   *  to full-resync. Clients compare `lastAppliedSeq[sid]` to server's seq for
   *  sync integrity. Missing (undefined) only on raw JSONL read before ingest. */
  seq?: number
}

export interface TranscriptAssistantMessage {
  model?: string
  id?: string
  type?: string
  role: 'assistant'
  content: TranscriptContentBlock[]
  stop_reason?: string | null
  stop_sequence?: string | null
  usage?: {
    input_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    output_tokens: number
    service_tier?: string
    speed?: string
    server_tool_use?: Record<string, number>
    cache_creation?: Record<string, number>
    inference_geo?: string
    iterations?: unknown[]
  }
}

export interface TranscriptUserEntry extends TranscriptEntryBase {
  type: 'user'
  message?: {
    role: 'user'
    content: string | TranscriptContentBlock[]
  }
  promptId?: string
  sourceToolAssistantUUID?: string
  sourceToolUseID?: string
  toolUseResult?: Record<string, unknown> | unknown[] | string
  isCompactSummary?: boolean
  isMeta?: boolean
  isVisibleInTranscriptOnly?: boolean
  imagePasteIds?: number[]
  permissionMode?: string
}

export interface TranscriptAssistantEntry extends TranscriptEntryBase {
  type: 'assistant'
  message?: TranscriptAssistantMessage
  requestId?: string
  isApiErrorMessage?: boolean
  error?: string
  /** CC stamps this on an assistant turn that was produced by a skill or slash
   *  command (e.g. `insights`). Raw passthrough from the JSONL -- the control
   *  panel renders it as a "via /name" attribution badge in the message header. */
  attributionSkill?: string
}

export interface TranscriptProgressEntry extends TranscriptEntryBase {
  type: 'progress'
  data?: Record<string, unknown>
  toolUseID?: string
  parentToolUseID?: string
}

/** Agent Host-generated boot timeline entry. Rendered above real CC messages
 *  during the pre-session-id phase. `raw` holds the full underlying payload
 *  (init message, exit info, etc.) for click-to-expand in the UI. */
export interface TranscriptBootEntry extends TranscriptEntryBase {
  type: 'boot'
  step: BootStep
  detail?: string
  raw?: unknown
}

/** Agent Host-generated CC launch lifecycle entry. Like TranscriptBootEntry but
 *  covers the full lifecycle including /clear reboots. launchId groups all
 *  steps of a single launch so the UI can render them as one card. */
export interface TranscriptLaunchEntry extends TranscriptEntryBase {
  type: 'launch'
  launchId: string
  phase: AgentHostLaunchPhase
  step: AgentHostLaunchStep
  detail?: string
  raw?: Record<string, unknown>
}

/** Agent Host-normalized advisor event (CC 2.1.170 server-side advisor tool).
 *  A worker can call advisor() to consult a stronger model (Fable); CC streams
 *  advisor_* subtypes which the agent host folds into one entry per event. */
export interface TranscriptAdvisorEntry extends TranscriptEntryBase {
  type: 'advisor'
  /** The advisor_* subtype that produced this (message | result | tool_result | ...). */
  advisorSubtype: string
  /** The advisor's text / verdict, when present (from content.text or text). */
  text?: string
  /** Model that produced the advice (e.g. claude-fable-5), when CC reports it. */
  advisorModel?: string
  /** Whether CC redacted the advice (advisor_redacted_result) or it errored. */
  redacted?: boolean
  isError?: boolean
  /** Full original CC payload for the JsonInspector (i) expansion. */
  raw?: Record<string, unknown>
}

export interface TranscriptSystemEntry extends TranscriptEntryBase {
  type: 'system'
  subtype?: 'stop_hook_summary' | 'turn_duration' | 'compact_boundary' | 'local_command' | string
  content?: string
  level?: string
  isMeta?: boolean
  stopReason?: string
  hookCount?: number
  hookErrors?: unknown[]
  hookInfos?: unknown[]
  preventedContinuation?: boolean
  hasOutput?: boolean
  durationMs?: number
  toolUseID?: string
  compactMetadata?: { trigger?: string; preTokens?: number }
}

export interface TranscriptQueueEntry extends TranscriptEntryBase {
  type: 'queue-operation'
  operation: 'enqueue' | 'remove' | 'dequeue' | 'popAll'
  content?: string
}

export interface TranscriptCompactingEntry extends TranscriptEntryBase {
  type: 'compacting' | 'compacted'
}

export interface TranscriptLastPromptEntry extends TranscriptEntryBase {
  type: 'last-prompt'
  lastPrompt?: string
}

export interface TranscriptPrLinkEntry extends TranscriptEntryBase {
  type: 'pr-link'
  prNumber?: number
  prRepository?: string
  prUrl?: string
}

export interface TranscriptSummaryEntry extends TranscriptEntryBase {
  type: 'summary'
  summary?: string
}

export interface TranscriptCustomTitleEntry extends TranscriptEntryBase {
  type: 'custom-title'
  customTitle?: string
}

export interface TranscriptAgentNameEntry extends TranscriptEntryBase {
  type: 'agent-name'
  agentName?: string
}

/**
 * Inline receipt for a spawn approval that has been resolved (allowed,
 * denied, failed, or timed out). Lives in the CALLER's transcript so the
 * conversation that invoked spawn sees the outcome where it asked.
 */
export interface TranscriptSpawnNotificationEntry extends TranscriptEntryBase {
  type: 'spawn_notification'
  requestId: string
  outcome: 'spawned' | 'denied' | 'failed' | 'timed_out'
  decidedAt: number
  /** Set when outcome=spawned -- the new conversation's id. */
  spawnedConversationId?: string
  jobId?: string
  /** Set when outcome=failed -- spawn dispatch error after approval. */
  error?: string
  /** Original SpawnRequest, for inline rendering + JsonInspector. */
  request: Record<string, unknown>
  /** True iff the user ticked "allow future spawn calls from this conversation". */
  persistChosen: boolean
}

/** Head / launch entry of an inline agent's transcript sub-stream. Carries the
 *  big mission/prompt + bulky launch args that must NOT ride the broadcast
 *  roster card (per plan-agent-transcript-separation 3b). Durable + FTS-searchable
 *  ("find an old agent by its mission"). Synthesized by the broker at
 *  SubagentStart from the launch metadata captured at PreToolUse(Agent). */
export interface TranscriptAgentLaunchEntry extends TranscriptEntryBase {
  type: 'agent_launch'
  agentId?: string
  agentType?: string
  model?: string
  description?: string
  prompt?: string
  args?: Record<string, unknown>
}

/** Inline receipt for a host-shell lifecycle event (open / exit), emitted into
 *  the attached conversation's transcript when `shell_open` carried a
 *  `conversationId`. Satisfies EVERYTHING-IS-A-STRUCTURED-MESSAGE: live PTY
 *  bytes stay ephemeral, but the open + exit facts are durable + inspectable.
 *  The shell itself is sentinel-owned and URI-addressed, NOT conversation-owned;
 *  this entry is a UI-grouping receipt only. See plan-host-shell.md 4.5. */
export interface TranscriptShellEntry extends TranscriptEntryBase {
  type: 'shell'
  shellId: string
  /** `open`: shell spawned. `exit`: PTY exited. */
  event: 'open' | 'exit'
  /** `claude://{sentinel}/{path}` the shell is bound to. */
  projectUri?: string
  /** Working directory the shell runs in (= URI path). */
  path?: string
  title?: string
  /** Exit code, set on `event: 'exit'`. */
  code?: number
  /** Identity (user name) that opened the shell. */
  createdBy?: string
  detail?: string
  /** Full underlying payload for click-to-expand in the (i) inspector. */
  raw?: Record<string, unknown>
}

export type TranscriptEntry =
  | TranscriptUserEntry
  | TranscriptAssistantEntry
  | TranscriptProgressEntry
  | TranscriptSystemEntry
  | TranscriptQueueEntry
  | TranscriptCompactingEntry
  | TranscriptLastPromptEntry
  | TranscriptPrLinkEntry
  | TranscriptSummaryEntry
  | TranscriptCustomTitleEntry
  | TranscriptAgentNameEntry
  | TranscriptBootEntry
  | TranscriptLaunchEntry
  | TranscriptAdvisorEntry
  | TranscriptAgentLaunchEntry
  | TranscriptSpawnNotificationEntry
  | TranscriptShellEntry
  | (TranscriptEntryBase & Record<string, unknown>) // fallback for unknown types

// Streaming output from background bash tasks (.output file watching)
export interface BgTaskOutput {
  type: 'bg_task_output'
  conversationId: string
  taskId: string
  data: string // new chunk of output
  done: boolean // true when task has completed and file is fully read
}

export interface AgentHostNotify {
  type: 'notify'
  conversationId: string
  message: string
  title?: string
}

/**
 * THE STATUS — the agent's self-reported, single-slot task state for the
 * per-conversation attention overview. Distinct from `ConversationStatusSignal`
 * (active/idle lifecycle) and `DaemonRunState`: this is what the AGENT says it's
 * doing, set via the `set_status` MCP tool. The `state` enum is the one required
 * triage signal (drives badge colour/icon); the text fields are detail-on-expand
 * and are individually optional ("empty is signal" — a fully-done conversation is
 * `state:'done'` + one line in `done`, everything else empty).
 */
export type LiveStatusState = 'working' | 'done' | 'needs_you' | 'blocked'

export interface LiveStatus {
  /** The one required triage signal. */
  state: LiveStatusState
  /** What FINISHED. */
  done?: string
  /** What still must happen for this to be COMPLETE (blocks "done"). */
  pending?: string
  /** Done-but-watch. */
  caveats?: string
  /** What did NOT get done + why (errors / dead-ends). */
  blocked?: string
  /** FYI asides that are NOT todos (e.g. "didn't commit/deploy"). */
  notes?: string
  /**
   * The agent's explicit "nothing in flight — safe to close this conversation"
   * signal. Set true only when there's no uncommitted/unpushed work, no pending
   * interaction, and nothing the user still needs from it. Surfaces as a visible
   * marker so the user can tell at a glance which conversations are disposable.
   */
  safe_to_close?: boolean
  /** Host-stamped monotonic ordering token (stale-drop guard). */
  seq: number
  /** Host wall-clock at set time. */
  updatedAt: number
}

/** The text fields the agent supplies to `set_status` (seq/updatedAt are host-stamped). */
export type LiveStatusInput = Omit<LiveStatus, 'seq' | 'updatedAt'>

/**
 * THE STATUS — a self-reported status is SUPERSEDED when a user impulse (a message
 * routed to the conversation) landed AFTER the status was set: the report predates
 * what the user did next, so it's kept around but no longer authoritative and must
 * read as stale, not active. The single source of truth for the "is this status
 * still active?" question — shared by the broker (REST overview + list_conversations)
 * and the control panel (card badge + transcript block) so they never drift.
 *
 * Deliberately keyed off `lastInputAt` (user impulse) ONLY, never `lastActivity`:
 * the agent emits text right after set_status, so lastActivity always edges just
 * past updatedAt and would falsely stale every status. (Mirrors list_conversations'
 * statusAge vs lastInputAge pairing.)
 */
export function isLiveStatusSuperseded(liveStatus: LiveStatus | undefined, lastInputAt: number | undefined): boolean {
  if (!liveStatus || lastInputAt == null) return false
  return lastInputAt > liveStatus.updatedAt
}

/**
 * Agent self-reported status (agent host -> broker -> dashboard). Single live
 * slot per conversation; a new one REPLACES the slot, full history stays in the
 * transcript. Re-broadcast verbatim to dashboards. AGENT_HOST_ONLY origin.
 */
export interface AgentStatusMessage {
  type: 'agent_status'
  conversationId: string
  status: LiveStatus
}

/** First frame from the agent host after the WS handshake, sent BEFORE CC has
 *  produced a session id. Gives the broker enough to create a
 *  placeholder "booting" conversation so the dashboard shows progress from t=0. */
export interface AgentHostBoot {
  type: 'agent_host_boot'
  /** Wire protocol version this client speaks. See AGENT_HOST_PROTOCOL_VERSION. */
  protocolVersion: number
  conversationId: string
  project: string
  capabilities: AgentHostCapability[]
  claudeArgs: string[]
  version?: string
  buildTime?: string
  agentHostType?: string
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
  launchConfig?: LaunchConfig
  title?: string
  description?: string
  startedAt: number
  configuredModel?: string // the --model value passed to CC (CC strips [1m] from API responses)
}

/** Structured agent host-side boot progress. Broker appends each one as a
 *  TranscriptBootEntry and broadcasts it as a transcript update, so the user
 *  sees the boot timeline live. `raw` is optional -- present for events with
 *  a rich payload (init message, exit info). */
export interface BootEvent {
  type: 'boot_event'
  conversationId: string
  step: BootStep
  detail?: string
  raw?: unknown
  t: number
}

/**
 * Launch events — structured, persistent timeline of the CC process launching,
 * re-launching (on /clear), and settling on a session id. Each logical launch
 * gets a fresh `launchId` (uuid); every step in that launch carries the same
 * id so the dashboard can group them. These are distinct from boot events:
 *   - BootEvent fires only during the initial boot phase (wrapper_started
 *     through conversation_ready) and is keyed by conversationId.
 *   - LaunchEvent covers the whole launch lifecycle including /clear reboots,
 *     is keyed by both conversationId AND launchId, and is rendered inline in the
 *     transcript so the user always sees "which CC am I talking to and how
 *     was it launched?". The full args/env/init payloads go in `raw` for the
 *     (i) JSON inspector.
 */
export type AgentHostLaunchPhase = 'initial' | 'reboot' | 'live'

export type AgentHostLaunchStep =
  | 'launch_started' // process about to be spawned. raw: { args, env, cwd, headless, channelEnabled, mcpConfigPath, settingsPath }
  | 'clear_requested' // /clear dispatched. detail: source. Only on reboot phase.
  | 'process_killed' // CC exited during reboot. raw: { code }
  | 'mcp_reset' // MCP channel torn down (reboot only)
  | 'settings_regenerated' // settings + mcp config re-written (reboot only)
  | 'init_received' // CC reported a session id. raw: { session_id, model, tools, slash_commands, skills, agents, mcp_servers, plugins, ... }
  | 'ready' // launch settled; session usable
  // Mid-session state changes -- broker emits these by diffing conversation_info
  // across turns. Phase is 'live' (not initial/reboot). Each gets its own launchId
  // so they render as separate cards in the transcript.
  | 'model_changed' // detail: "old -> new". raw: { from, to }
  | 'permission_mode_changed' // detail: "old -> new". raw: { from, to }
  | 'fast_mode_changed' // detail: "on/off". raw: { from, to }
  | 'mcp_servers_changed' // detail: "+1 / -2". raw: { added, removed, current }
  | 'tools_changed' // detail: "+N / -N". raw: { added, removed, count }
  | 'slash_commands_changed' // detail: "+N / -N". raw: { added, removed, count }
  | 'skills_changed' // detail: "+N / -N". raw: { added, removed, count }
  | 'agents_changed' // detail: "+N / -N". raw: { added, removed, count }
  | 'plugins_changed' // detail: "+N / -N". raw: { added, removed, count }
  | 'conversation_exit' // self-termination via exit_session MCP tool. raw: { status, message }

/**
 * Agent Host -> broker -> dashboard: CC process launch lifecycle event.
 * Separate from `LaunchProgressEvent` (broker-initiated spawn jobs):
 * WrapperLaunchEvent is emitted by the agent host itself and covers its local
 * CC process launching, re-launching on /clear, and settling on a session id.
 */
export interface AgentHostLaunchEvent {
  type: 'launch_event'
  conversationId: string
  launchId: string
  phase: AgentHostLaunchPhase
  step: AgentHostLaunchStep
  /** CC session id at the time of the step. null before init_received. */
  ccSessionId: string | null
  detail?: string
  raw?: Record<string, unknown>
  t: number
}

/** Tells the broker to promote the boot session to a real session once
 *  CC has produced a session id. Source indicates which channel won the race
 *  (stream-json init in headless, SessionStart hook in PTY). */
export interface ConversationPromote {
  type: 'conversation_promote'
  conversationId: string
  ccSessionId: string
  source: 'stream_json' | 'hook'
}

/**
 * Agent host -> broker. Fired on EVERY (re)connect from the shared host
 * transport, BEFORE business traffic resumes. Lets the broker correlate
 * what the host saw at the wire level (close codes, reconnect attempt,
 * queue/ring depth, which initial message type it chose) with what the
 * broker observed on its side.
 *
 * The missing half of every "[unknown] [boot]" + "[ws] Connection closed
 * code=1000 reason=none" diagnostic riddle.
 */
export interface HostTransportReconnect {
  type: 'host_transport_reconnect'
  conversationId: string
  /** 0 on the very first connect of this transport, N>0 on subsequent retries. */
  attempt: number
  /** Close code from the PREVIOUS ws.onclose. Undefined on attempt=0. */
  prevCloseCode?: number
  /** Close reason from the PREVIOUS ws.onclose. Undefined on attempt=0. */
  prevCloseReason?: string
  /** ms between previous ws.onclose and this ws.onopen. Undefined on attempt=0. */
  msSinceLastConnect?: number
  /** Outbound queue depth at the moment we opened the new socket. */
  queuedMessages: number
  /** Transcript ring buffer depth (entries pending replay). */
  ringBufferDepth: number
  /**
   * Which initial message type the transport sent. 'meta' on resume,
   * 'agent_host_boot' on early-connect (no ccSessionId yet), or any
   * future variant the host registers via buildInitialMessage.
   */
  initialMessageType: string
  /** Whether the host's local lastSessionId was non-null at connect time. */
  hasSessionId: boolean
  /** rclaude/HASH version string of the agent host process. */
  hostVersion?: string
  /** Wall-clock timestamp the new ws.onopen fired. */
  at: number
}

export type AgentHostMessage =
  | HookEvent
  | ConversationMeta
  | ConversationEnd
  | ConversationReset
  | UpdateConversationMetadata
  | AgentHostBoot
  | BootEvent
  | AgentHostLaunchEvent
  | ConversationPromote
  | Heartbeat
  | TerminalData
  | TerminalError
  | TasksUpdate
  | TranscriptEntries
  | SubagentTranscript
  | FileResponse
  | BgTaskOutput
  | AgentHostNotify
  | InterConversationMessage
  | DispatchRequest
  | ProjectLinkResponse
  | InterConversationListRequest
  | PermissionRequest
  | AskQuestionRequest
  | ClipboardCapture
  | DialogShowMessage
  | DialogDismissMessage
  | DialogPatchMessage
  | DialogReopenMessage
  | AgentStatusMessage
  | DialogOrphanedMessage
  | DialogLiveDismissedMessage
  | PlanApprovalRequest
  | PlanModeChanged
  | StreamDelta
  | AgentHostRateLimitStatus
  | ConversationInfoUpdate
  | ConversationNameUpdate
  | ConversationModelUpdate
  | CwdChangedMessage
  | ThinkingProgress
  | SpawnFailed
  | MonitorUpdate
  | ScheduledTaskFire
  | ConversationStatusSignal
  | JsonStreamData
  | HostTransportReconnect
  | DaemonLaunchEvent
  | DaemonControlResult
  | DaemonSessionRetired
  | DaemonStatePatch
  | DaemonBlockObserved
  | EffortChanged
  | DebugTraceEvent
  | DebugControlResult
  | WebControlRelayRequest

export interface ConversationNameUpdate {
  type: 'conversation_name'
  conversationId: string
  name: string
  description?: string
}

/**
 * Backend-agnostic "the agent switched its active model mid-session" signal.
 *
 * Claude Code announces a runtime model switch (`/model fable`, or our own
 * set_model control verb) with a `system/informational` transcript line whose
 * content is `Model changed to <model>`. The informational line shows the user
 * WHAT happened, but it never updates the conversation's tracked model -- so the
 * header pill kept showing the launch model. The agent host parses that line
 * (the only place allowed to read CC output) and emits this structured message;
 * the broker updates `conversation.model` so the header reflects the switch.
 */
export interface ConversationModelUpdate {
  type: 'conversation_model'
  conversationId: string
  model: string
}

/**
 * Backend-agnostic "the agent is now working in directory X" signal.
 *
 * Each agent host translates ITS backend's native cwd notion into this one
 * message (CC's `CwdChanged` hook, EnterWorktree/ExitWorktree tool results,
 * a daemon/ACP cwd report, ...). The broker reads only `cwd` and never parses
 * a backend-specific payload -- same boundary as tool-vocab does for tools.
 * Sets `Conversation.currentPath`; `Conversation.project` (the identity URI)
 * is never touched.
 */
export interface CwdChangedMessage {
  type: 'cwd_changed'
  conversationId: string
  /** Absolute working directory the agent moved into. */
  cwd: string
}

/**
 * Backend-agnostic "the model is currently thinking" live progress ping.
 *
 * Emitted while the backend is in an extended-thinking phase (CC's
 * `system/thinking_tokens` events; equivalent signals from other backends).
 * Each agent host translates ITS backend's native thinking-progress signal
 * into this one shape. The broker reads only `tokens` / `delta` -- never a
 * backend-specific payload -- and forwards to live subscribers.
 *
 * EPHEMERAL: this is an explicit, documented deviation from the
 * EVERYTHING IS A STRUCTURED MESSAGE persist+replay default. Thinking
 * progress is a pure liveness/presence cue (like a typing indicator),
 * visible only to currently-watching subscribers. The broker MUST NOT
 * persist it or add it to any replay buffer; the agent host MUST NOT
 * buffer it across reconnects. On reload, the transcript shows no trace.
 *
 * Terminus: NOT carried by a separate message. The control panel clears
 * the live indicator when (a) a new `assistant` transcript entry arrives
 * for the conversation, or (b) no ping has been seen for ~4s.
 */
export interface ThinkingProgress {
  type: 'thinking_progress'
  conversationId: string
  /** Cumulative thinking-token estimate from the backend. */
  tokens: number
  /** Increment since the previous ping. Optional -- first ping has no delta. */
  delta?: number
  /** Wall-clock timestamp at the agent host, ms since epoch. */
  t: number
}

// Session info from stream-json init (skills, tools, agents, etc.)
export interface ConversationInfoUpdate {
  type: 'conversation_info'
  conversationId: string
  tools: string[]
  slashCommands: string[]
  skills: string[]
  agents: string[]
  mcpServers: Array<{ name: string; status?: string }>
  plugins: Array<{ name: string; source?: string }>
  model: string
  permissionMode: string
  claudeCodeVersion: string
  fastModeState: string
}

/**
 * The richer daemon run-state vocab from the cc-daemon `subscribe` state stream
 * (transport-reframe Phase 7, control surface uplift #12d). Live-confirmed
 * values 2026-05-23: `running`, `working` (snapshot + state patches). The rest
 * are from the daemon state-machine inventory (protocol doc § 5.5): a worker
 * may also report `blocked` (interaction gate), `resuming`, `failed`, `done`,
 * `crashed`. PTY/headless transports do not produce this; it rides only on a
 * `claude-daemon` conversation_status.
 */
export type DaemonRunState = 'running' | 'working' | 'blocked' | 'resuming' | 'failed' | 'done' | 'crashed'

// Backend-agnostic session status signal (agent host -> broker)
// Works for any backend (headless stream-json, PTY, future transports).
// Fired when the agent host detects work starting/stopping, independent of CC hooks.
export interface ConversationStatusSignal {
  type: 'conversation_status'
  conversationId: string
  status: 'active' | 'idle'
  /**
   * DAEMON TRANSPORT UPLIFT (#12d): the cc-daemon worker's richer run-state and
   * human-readable detail, mirrored from the `subscribe` state stream by the
   * daemon-agent-host status mirror. `status` (active/idle) is derived from the
   * daemon `tempo`; `daemonState` carries the finer vocab and `detail` the
   * worker's own status string ("running echo SPIKE_OK"). Absent for PTY/headless.
   */
  daemonState?: DaemonRunState
  detail?: string
}

// Headless streaming deltas (token-by-token from --include-partial-messages)
export interface StreamDelta {
  type: 'stream_delta'
  conversationId: string
  event: Record<string, unknown> // raw Anthropic API SSE event
}

// Raw NDJSON stream (headless sessions only -- dashboard tails raw CC output)
// Mirrors terminal_attach/detach pattern: agent host only sends when viewers are attached.
export interface JsonStreamAttach {
  type: 'json_stream_attach'
  conversationId: string
}

export interface JsonStreamDetach {
  type: 'json_stream_detach'
  conversationId: string
}

export interface JsonStreamData {
  type: 'json_stream_data'
  conversationId: string
  lines: string[] // raw NDJSON lines from CC stdout
  isBackfill: boolean // true for initial batch on attach
}

// Rate limit status from headless stream-json backend.
// CC emits rate_limit_event for three cases:
//   - 'allowed' (utilization cleared)
//   - 'limited' WITH retry_after_ms (actual block -- CC tells us how long to wait)
//   - 'limited' WITHOUT retry_after_ms (NOTICE -- e.g. 7-day soft warning at 80-85%)
// The discriminator between actual-block vs notice is `retryAfterMs` presence.
// The agent host translates to this high-level message.
export interface AgentHostRateLimitStatus {
  type: 'rate_limit_status'
  conversationId: string
  status: 'limited' | 'allowed'
  /** Present only when CC actually rate-limited (HTTP 429-equivalent). Absent for notices. */
  retryAfterMs?: number
  rateLimitType?: string
  /** Epoch ms when the bucket resets. Agent host normalizes CC's seconds-resolution value. */
  resetsAt?: number
  /** Plan utilization (0-1) for the REPRESENTATIVE window named by `rateLimitType`,
   *  read off the `anthropic-ratelimit-unified-*` data CC surfaces on every inference
   *  turn. The broker folds this into the per-(sentinel, profile) usage store so the
   *  control-panel bars stay truthful even when the dedicated /api/oauth/usage poll is
   *  429'd. See `src/broker/conversation-store/usage-merge.ts`. */
  utilization?: number
  raw?: Record<string, unknown>
}

// Clipboard capture from PTY OSC 52 sequences
export interface ClipboardCapture {
  type: 'clipboard_capture'
  conversationId: string
  contentType: 'text' | 'image'
  text?: string // decoded text (for text content)
  base64?: string // raw base64 (for images -- text omits this to save bandwidth)
  mimeType?: string // 'image/png', 'image/jpeg', etc.
  timestamp: number
}

// Broker -> Agent Host messages
export interface Ack {
  type: 'ack'
  eventId: string
  origins?: string[]
}

export interface BrokerError {
  type: 'error'
  message: string
}

/**
 * Broker -> agent host: the agent host's protocol version is too old.
 *
 * Sent when meta/wrapper_boot arrives without a `protocolVersion` field, or
 * with a version below what the broker speaks. The agent host MUST treat
 * this as fatal -- print the message + upgrade command to its terminal,
 * close the WS, and exit (or bail out of the connect loop). Reconnecting
 * with the same binary will just hit the same rejection.
 */
export interface ProtocolUpgradeRequired {
  type: 'protocol_upgrade_required'
  /** What the broker speaks (current version). */
  serverProtocolVersion: number
  /** What the client sent. `null` means the field was missing entirely (legacy v1). */
  clientProtocolVersion: number | null
  /** Plain-English explanation of why the connection was rejected. */
  reason: string
  /** Copy-pastable shell command to upgrade. Safe to print verbatim. */
  upgradeCommand: string
  /** Optional secondary detail (e.g. which fields renamed). */
  details?: string
}

/**
 * Broker -> dashboard: surface that an outdated agent host tried to connect.
 *
 * Broadcast alongside the `protocol_upgrade_required` reply so that dashboard
 * users see the problem even if the agent host's terminal is hidden (running
 * under a tmux session, in a daemon, etc).
 */
export interface AgentHostOutdated {
  type: 'agent_host_outdated'
  /** Connection identifier that tried to connect (best-effort, may be null). */
  conversationId: string | null
  /** Project URI / cwd if we could parse one out of the malformed meta. */
  project: string | null
  /** What the broker speaks. */
  serverProtocolVersion: number
  /** What the client sent. `null` if missing entirely. */
  clientProtocolVersion: number | null
  /** Copy-pastable upgrade command to display in the toast. */
  upgradeCommand: string
  /** Plain-English reason. */
  reason: string
}

export interface SendInput {
  type: 'input'
  conversationId: string
  input: string
  crDelay?: number // carriage return delay in ms (dashboard setting, optional)
}

// Transcript streaming: broker -> rclaude
export interface TranscriptRequest {
  type: 'transcript_request'
  conversationId: string
  limit?: number
}

export interface SubagentTranscriptRequest {
  type: 'subagent_transcript_request'
  conversationId: string
  agentId: string
  limit?: number
}

export interface FileRequest {
  type: 'file_request'
  requestId: string
  path: string
}

export interface TranscriptKick {
  type: 'transcript_kick'
  conversationId: string
}

// Persistent inter-conversation link (project-pair based, survives restarts)
export interface LinkSummary {
  projectA: string
  projectB: string
  nameA: string
  nameB: string
  createdAt: number
  lastUsed: number
  online: boolean // true if both CWDs have active conversations
}

// Inter-conversation messaging (channel-enabled conversations only)
export type InterConversationIntent = 'request' | 'response' | 'notify' | 'progress'

export interface InterConversationMessage {
  type: 'channel_send'
  fromConversation: string
  // Single target (back-compat) OR multicast to many. When an array is passed,
  // the broker fans out and produces ONE `channel_send_result` carrying a
  // per-target `results[]` breakdown. The same `conversationId` (thread id)
  // is reused for every recipient so replies land in one logical thread.
  toConversation: string | string[]
  intent: InterConversationIntent
  message: string
  context?: string
  conversationId?: string
  /** Optional batch correlation id (e.g. `batch_<nanoid>`) set by clients
   *  fanning out a batch command across many conversations. The broker logs
   *  it so `grep batch_<id>` reconstructs the full fan-out. Not interpreted. */
  batchId?: string
}

export interface ChannelSendResultEntry {
  // The raw target the caller passed (compound id, project slug, or conversation id).
  to: string
  ok: boolean
  status?: 'delivered' | 'queued'
  targetConversationId?: string
  error?: string
  /** Set when delivery resolved via a RETIRED (former) slug -- the `to` used an
   *  old name the target shed in a rename. Carries the canonical CURRENT address
   *  (`project:new-slug`) so the sender can update its cached `to`. Old names
   *  decay; store targetConversationId for durable references. */
  canonicalAddress?: string
}

export interface ChannelSendResult {
  type: 'channel_send_result'
  // Aggregate success: true iff every target succeeded.
  ok: boolean
  // Thread id shared by all fan-out targets.
  conversationId?: string
  // Single-target back-compat fields (populated when caller passed a string).
  status?: 'delivered' | 'queued'
  targetConversationId?: string
  error?: string
  // Multicast breakdown (populated when caller passed an array).
  results?: ChannelSendResultEntry[]
}

export interface InterConversationDelivery {
  type: 'channel_deliver'
  fromConversation: string
  fromProject: string
  intent: InterConversationIntent
  message: string
  context?: string
  conversationId?: string
}

/**
 * A broker-originated system notice pushed into a conversation's input,
 * rendered as `<channel source="rclaude" sender="system" kind="...">`.
 * Distinct from InterConversationDelivery (untrusted peer messages) -- this
 * is trusted broker infrastructure, e.g. the recap-completed push that
 * backs inform_on_complete.
 */
export interface SystemChannelDelivery {
  type: 'system_channel_deliver'
  /** Channel `kind` attribute, e.g. 'recap-completed'. */
  kind: string
  /** Message body delivered to the agent. */
  text: string
  /** Optional recap id, surfaced as a `recap_id` attribute for the renderer. */
  recapId?: string
}

// ─── Dispatch (Front Desk routing brain) ────────────────────────────────
// The dispatcher takes an INTENT and decides a DISPOSITION -- spawn a NEW
// conversation, ROUTE a message to an existing one, or REVIVE an ended one --
// then executes via the existing spawn/route/revive handlers. Every decision
// is broadcast as a `dispatch_decision` (the structured-message backbone) and
// audited. `desk.dispatch` is the verb; see .claude/docs/plan-dispatcher-build.md.

/** Disposition the dispatcher chose for an intent.
 *  - `new`/`route`/`revive` push work to a conversation (spawn / inject / reopen).
 *  - `ask` = unsure, surface candidate cards for one-click select.
 *  - `converse` = the user is talking TO the concierge (greeting, "what's going
 *    on?", a quick status question). Answer directly via `DispatchDecision.reply`;
 *    nothing is spawned or routed. This is the front desk's "just talk to me" path. */
export type DispatchDisposition = 'new' | 'route' | 'revive' | 'ask' | 'converse'

/** Relative cost reading for a route/spawn target -- the confirmation-gate input.
 *  Metrics are read off the existing Conversation record (token_samples /
 *  lastActivity / cost), NOT re-emitted by status-tool. */
export interface DispatchCostSignal {
  tier: 'cheap' | 'moderate' | 'expensive' | 'very_expensive'
  contextTokens?: number
  idleMs?: number
  /** True when idle past the cache TTL -> a resume re-pays full context. */
  coldCache?: boolean
  /** Model/profile expense note, e.g. 'opus'. */
  model?: string
  /** Human-facing reason, e.g. 'resumes a 180k-token Opus conv, cold cache'. */
  note?: string
}

/** A candidate conversation surfaced for the rich `ask` (conversation_select)
 *  UX -- rendered as a selectable card with commentary. */
export interface DispatchCandidate {
  conversationId: string
  project?: string
  title?: string
  /** One-line commentary: why it matched / what it's doing. */
  commentary?: string
  /** status-tool LiveStatus.state when the status feed is available.
   *  Tighten to `LiveStatus['state']` once that type lands in main. */
  liveState?: string
  cost?: DispatchCostSignal
  /** Classifier score 0..1. */
  score?: number
}

/** A conversation a thread has used, with when it was last used. */
export interface DispatchThreadConversation {
  conversationId: string
  /** Display label cached at usage time (the conv may rename/end later). */
  label?: string
  lastUsedAt: number
}

/**
 * A dispatcher "thread" -- its near-memory (plan-dispatcher-build.md §9.3).
 *
 * A thread is a VIEW of context: a super-local, tiny State-of-the-Union board
 * for one topic the dispatcher is managing right now. It is the dispatcher's
 * near memory, kept deliberately small (the dispatcher itself holds almost no
 * context). Each thread carries free TEXT (title + summary) + JSON metadata,
 * and the conversations it has used WITH the last-used timestamp per
 * conversation. Viewable so the user can see what the dispatcher remembers.
 */
export interface DispatchThread {
  id: string
  /** Short human label for the thread. */
  title: string
  /** Free-text near-memory: what this thread is about, current state. */
  summary: string
  /** Arbitrary structured metadata (entities, tags, status, ...). */
  metadata?: Record<string, unknown>
  /** Conversations this thread has used, most-recently-used first. */
  conversations: DispatchThreadConversation[]
  createdAt: number
  updatedAt: number
}

/** web/MCP -> broker: ask the dispatcher to route an intent. */
export interface DispatchRequest {
  type: 'dispatch_request'
  /** Natural-language intent. */
  intent: string
  /** Explicit target (conversationId or project) -> override-first, no LLM. */
  target?: string
  /** Explicit disposition override -> honor without re-deciding. */
  disposition?: DispatchDisposition
  /** Set once the user confirmed an expensive route (the cost gate). */
  confirmedExpensive?: boolean
  /** Override the model that drives the dispatcher agent loop for this turn
   *  (user-switchable in the overlay). Omitted -> the desk default. */
  model?: string
  /** Correlation id so the resulting decision can be matched back. */
  requestId?: string
}

/** broker -> web (broadcast + audit): the routing decision the dispatcher made.
 *  Emitted for EVERY decision -- including `ask` (unsure) and decisions held at
 *  the cost-confirmation gate (`awaitingConfirmation`). */
export interface DispatchDecision {
  type: 'dispatch_decision'
  decisionId: string
  intent: string
  disposition: DispatchDisposition
  /** convId (route/revive) or project/profile id (new). */
  target?: string
  confidence: number
  reasoning: string
  /** Populated when disposition === 'ask' (the conversation_select cards). */
  candidates?: DispatchCandidate[]
  /** The concierge's spoken/written answer, populated when disposition ===
   *  'converse'. A direct reply to the user (briefing / status / chit-chat) --
   *  nothing was spawned or routed. The overlay renders this as the desk's reply. */
  reply?: string
  /** Cost reading for the chosen target; drives the confirmation gate. */
  cost?: DispatchCostSignal
  /** True once the disposition was executed via the underlying handler. */
  executed: boolean
  /** Set when execution is held pending an explicit expensive-route confirm. */
  awaitingConfirmation?: boolean
  /** The conversation the decision produced/targeted, once known. */
  resultConversationId?: string
  /** The model that drove the agent loop for this decision (so the overlay can
   *  show "talking to X"). Resolved from the request override or the desk default. */
  model?: string
  /** How many tool calls the agent loop ran this turn (the gears count). */
  toolCallCount?: number
  traceId: string
  ts: number
  /**
   * The user this decision belongs to (the dispatcher near-memory / decisions
   * are PER-USER). Nullable + forward-compatible: the broker WS seam stamps it
   * from the authed connection today; the backend store gains a `user_id`
   * column in the per-user increment. The overlay scopes on this.
   */
  userId?: string | null
}

/** One dialogue turn in the dispatcher's history (a user impulse or its reply). */
export interface DispatchHistoryTurn {
  role: string
  content: string
  ts: number
}

/** One addressable XML STATE BLOCK in the dispatcher's living history. */
export interface DispatchHistoryBlock {
  id: string
  tag: string
  content: string
  ts: number
}

/**
 * A full, inspectable snapshot of one user's dispatcher LIVING HISTORY -- the
 * SOLE SOURCE OF TRUTH the overlay renders. `transcript` is the viewable 100-turn
 * ring (decoupled from LLM-window pruning, A0); `turns` is the live LLM window
 * (consolidation prunes these); `blocks` is the mutable state the agent reads.
 * The broker computes this (broker `HistoryDump` is this shape); the web consumes it.
 */
export interface DispatchHistoryDump {
  exists: boolean
  userKey: string
  blocks: DispatchHistoryBlock[]
  turns: DispatchHistoryTurn[]
  transcript: DispatchHistoryTurn[]
  estimatedTokens: number
  lastConsolidatedAt: number | null
}

/** broker -> ALL of a user's open overlays (userId-scoped broadcast): the current
 *  dispatcher history, pushed live on EVERY mutation. Each device is a window onto
 *  the same continuously-updating state -- never its own copy, never a reset. */
export interface DispatchHistoryMessage {
  type: 'dispatch_history'
  userId: string | null
  history: DispatchHistoryDump
}

/** Control-panel -> broker: fetch the current user's dispatcher near-memory
 *  threads. A thin request/response over the dashboard WS (the `dispatch`/
 *  `list_threads` MCP tools have no authed-user identity; the WS connection
 *  does). The broker replies with `DispatchThreadsResult`. */
export interface DispatchListThreadsRequest {
  type: 'dispatch_list_threads'
  /** Max threads (default 50). */
  limit?: number
  /** Correlation id so the reply can be matched to this request. */
  requestId?: string
}

/** broker -> the requesting control panel: the resolved dispatch decision for a
 *  `dispatch_request`, correlated by `requestId`. The same decision is also
 *  broadcast as a `DispatchDecision` to all subscribers (audit/live); this is
 *  the direct, correlated reply to the caller. */
export interface DispatchRequestResult {
  type: 'dispatch_request_result'
  requestId?: string
  ok: boolean
  decision?: DispatchDecision
  error?: string
}

/** broker -> web (streamed DURING an agent-loop turn): one tool the dispatcher
 *  agent invoked. The overlay renders these DIMMED inline so the user sees the
 *  gears turn (list/inject/interrupt/terminate/spawn/configure/...). Correlated
 *  to its result by `callId`. (EVERYTHING-IS-A-STRUCTURED-MESSAGE.) */
export interface DispatchToolCall {
  type: 'dispatch_tool_call'
  requestId?: string
  traceId: string
  /** Unique per call within the turn; pairs with DispatchToolResult.callId. */
  callId: string
  /** Tool name, e.g. 'list_conversations'. */
  name: string
  /** One-line human summary of the call (NOT the raw payload). */
  summary?: string
  /** The validated args, for the JsonInspector (i) expansion. */
  args?: Record<string, unknown>
  ts: number
  userId?: string | null
}

/** broker -> web (streamed): the outcome of a DispatchToolCall. */
export interface DispatchToolResult {
  type: 'dispatch_tool_result'
  requestId?: string
  traceId: string
  callId: string
  ok: boolean
  /** One-line human summary of the outcome. */
  summary?: string
  /** Structured result for the JsonInspector (i) expansion. */
  result?: unknown
  error?: string
  ts: number
  userId?: string | null
}

/** broker -> the requesting control panel: the user's near-memory threads PLUS
 *  the live roster (active conversations the desk currently covers), so the
 *  overlay can SHOW what the concierge is holding -- not just route into it. */
export interface DispatchThreadsResult {
  // Conventional `${request}_result` name so the message-router's auto error reply
  // for a thrown `dispatch_list_threads` handler (permission gate) reaches the SAME
  // client handler as success -- otherwise a failure is unmatched and the overlay
  // wedges on "loading" forever (dead-on-open). Success carries no `ok`; the error
  // reply carries ok:false + error.
  type: 'dispatch_list_threads_result'
  ok?: boolean
  error?: string
  requestId?: string
  /** Active conversations across ALL projects, as selectable cards ("active right
   *  now"). The dispatcher is GLOBAL -- not project-scoped. Threads are short-term
   *  memory folded into the dispatcher's context, NOT surfaced here. */
  roster?: DispatchCandidate[]
  /** The dispatcher's durable memory file (markdown), so the overlay can show
   *  what it remembers long-term. Absent on older brokers. */
  memory?: string
  /** The dispatcher's virtual-fs scratch workspaces (/work/<x>), for inspection. */
  workspaces?: { workspace: string; files: string[] }[]
  /** The current LIVING HISTORY (conversation transcript + state blocks), so opening
   *  the overlay loads the persistent conversation, not blank (Slice C). Absent on
   *  older brokers -> the overlay falls back to the live decision feed. */
  history?: DispatchHistoryDump
  /** The authed user the threads were scoped to (null when single-user). */
  userId?: string | null
}

export interface ProjectLinkRequest {
  type: 'channel_link_request'
  fromConversation: string
  fromProject: string
}

export interface ProjectLinkResponse {
  type: 'channel_link_response'
  conversationId: string
  action: 'approve' | 'block'
}

/**
 * Control-panel -> broker: grant an ad-hoc inter-conversation link without the
 * approval dance. Emitted when the user SENDS a message containing a
 * `<conversation>` reference token (the `:` completer's output). The grant is
 * CONVERSATION-scoped (only the two conversations, NOT their projects) and
 * bidirectional. The broker resolves both ids itself; no project info on the wire.
 */
export interface ProjectLinkGrant {
  type: 'channel_link_grant'
  /** The conversation the user is messaging FROM (the one referencing). */
  fromConversation: string
  /** The referenced conversation (target of the link). */
  toConversation: string
}

/**
 * Broker -> dashboard broadcast: a link was just granted (newly created). The
 * control panel surfaces a toast so the auto-authorization is visible to the
 * user (auth_visible). Carries full context for logging/rendering.
 */
export interface ProjectLinkGranted {
  type: 'channel_link_granted'
  /**
   * Granularity of the link that was created. `conversation` = the `:` ad-hoc grant
   * (only the two conversations). `project` = a project-wide link. Absent = legacy
   * (treat as project). The `:` completer path always emits `conversation`.
   */
  scope?: 'conversation' | 'project'
  fromConversation: string
  fromProject: string
  toConversation: string
  toProject: string
  /** Human label for the linked target (conversation title for conv scope, else project). */
  toProjectLabel: string
}

export interface InterConversationListRequest {
  type: 'channel_list_conversations'
  status?: 'live' | 'inactive' | 'all'
  /** Verbosity tier. Defaults to `minimal` -- trims ~75% of the wire bytes vs.
   *  the historical full row. See channel.ts handler comment for the matrix. */
  fields?: 'minimal' | 'standard' | 'full'
  /** Additive field overrides on top of the tier. Comma-separated string OR
   *  string[]. Names: 'project', 'conversation_id', 'description', 'link',
   *  'uris', 'capabilities', 'title', 'summary', 'label', 'metadata', 'self'. */
  include?: string[] | string
  /** Legacy: equivalent to `include: ['metadata']`. Still honored. */
  show_metadata?: boolean
}

export interface InterConversationListResponse {
  type: 'channel_conversations_list'
  conversations: Array<{
    /** Stable routable address (`project:conversation-slug`). Always present. */
    id: string
    /** Display name. Always present. */
    name: string
    /** Always present. */
    status: 'live' | 'inactive' | 'spawning'
    /** Marker on the caller's own row (minimal tier surfaces self via this). */
    self?: true
    /** Sentinel alias hosting this conversation. Omitted for non-sentinel
     *  backends (hermes, chat-api) and when the owning sentinel is offline. */
    host?: string
    /** Sentinel-profile name. Omitted when the implicit default profile is in
     *  use or when the backend does not support profiles. */
    profile?: string
    /** Number of messages queued for this conversation while offline. Omitted
     *  when zero. Always present when > 0 (no tier gating). */
    queued?: number
    /** Tier `standard`+: project-level grouping slug. */
    project?: string
    /** Tier `standard`+: broker-internal conversation UUID. */
    conversation_id?: string
    /** Tier `standard`+: free-form description. */
    description?: string
    /** Tier `standard`+: link state with caller (`connected` | `blocked`). */
    link?: 'connected' | 'blocked'
    /** Tier `full` (or `include: ['uris']`): canonical project URI. */
    projectUri?: string
    /** Tier `full`: permanent record handle `{projectUri}#{conversation_id}`. */
    conversationUri?: string
    /** Tier `full`: capability flags. */
    capabilities?: string[]
    /** Tier `full`: conversation title (raw, may equal `name`). */
    title?: string
    /** Tier `full`: short summary string. */
    summary?: string
    /** Tier `full`: project label when distinct from `name`. */
    label?: string
    /** Tier `full`: project metadata bag (benevolent callers only). */
    metadata?: { label?: string; icon?: string; color?: string; keyterms?: string[] }
    /** Self-row mirror in tier `full`. */
    model?: string
    permissionMode?: string
    effortLevel?: string
    /** Only present on `status: "spawning"` rows. The job behind this entry. */
    spawnJobId?: string
    /** Only present on `status: "spawning"` rows. Last lifecycle step observed. */
    spawnStep?: string
  }>
  /** Top-level structured self block. Returned in `standard`+ (or with
   *  `include: ['self']`). In `minimal`, callers find self via the row's
   *  `self: true` marker. */
  self?: {
    id: string
    project: string
    conversation_id: string
    name: string
    status: 'live'
    host?: string
    profile?: string
    /** `full` tier only. */
    projectUri?: string
    conversationUri?: string
    model?: string
    permissionMode?: string
    effortLevel?: string
  }
  /**
   * Issues encountered while enumerating conversations (capped at 10).
   * Only present for benevolent callers, and only when issues > 0. Surfaces
   * row skips / self-block failures that would otherwise only land in
   * `docker logs broker`. Non-benevolent callers never see this field.
   */
  issues?: Array<{
    severity: 'error' | 'warning'
    code: string
    conversation_id?: string
    project?: string
    message: string
  }>
}

// AskUserQuestion relay (CC 2.1.85+ PreToolUse hook -> dashboard -> hook response)
export interface AskQuestionOption {
  label: string
  description: string
  preview?: string
}

export interface AskQuestionItem {
  question: string
  header: string
  options: AskQuestionOption[]
  multiSelect?: boolean
}

export interface AskQuestionRequest {
  type: 'ask_question'
  conversationId: string
  toolUseId: string
  questions: AskQuestionItem[]
}

export interface AskQuestionResponse {
  type: 'ask_answer'
  conversationId: string
  toolUseId: string
  answers: Record<string, string> // question text -> selected label(s)
  annotations?: Record<string, { preview?: string; notes?: string }>
  skip?: boolean // true = fall through to terminal UI
}

// Broker -> dashboard broadcast: a pending AskUserQuestion was resolved (by any
// session, or on the agent-host side). Tells every other subscriber to drop the
// question card. Mirror of dialog_dismiss for the AskUserQuestion flow.
export interface AskQuestionDismiss {
  type: 'ask_dismiss'
  conversationId: string
  toolUseId: string
}

// Agent host -> broker: headless AskUserQuestion expired with no user response.
// Broker treats it identically to a skipped ask_answer: clears pending state and
// broadcasts ask_dismiss so the question card disappears on all dashboard sessions.
export interface AskQuestionTimeout {
  type: 'ask_question_timeout'
  conversationId: string
  toolUseId: string
}

// THE DIALOGUE — live/persistent dialog contract (snapshot + op grammar).
export type { DialogOp, DialogSnapshot } from './dialog-live'
// Dialog MCP tool (channel-based rich UI for user interaction)
export type { DialogComponent, DialogLayout, DialogResult } from './dialog-schema'

export interface DialogShowMessage {
  type: 'dialog_show'
  conversationId: string
  dialogId: string
  layout: DialogLayout
}

export interface DialogResultMessage {
  type: 'dialog_result'
  conversationId: string
  dialogId: string
  result: DialogResult
  [key: string]: unknown
}

export interface DialogDismissMessage {
  type: 'dialog_dismiss'
  conversationId: string
  dialogId: string
  // 'timeout' = the dialog timed out on the agent host but the layout is kept
  // re-displayable (expired). Absent/other = hard dismiss (answered/cancelled/ended).
  reason?: 'timeout'
}

// ─── THE DIALOGUE — live/persistent dialog wire (host -> broker -> panel) ──
//
// All three carry a host-authoritative `DialogSnapshot`. The broker persists the
// snapshot blob OPAQUELY (boundary rule: no ccSessionId, never interpreted) and
// routes/replays it. The panel reconciles by stable block id. D1b emits these;
// the broker handlers + persistence land in D1c.

/** Agent patched a live dialog. `ops` drive the panel's visible reconciliation;
 *  `snapshot` is the new authoritative state the broker persists. `baseSeq` is
 *  the snapshot the ops applied to; `seq` (in the snapshot) is the result. */
export interface DialogPatchMessage {
  type: 'dialog_patch'
  conversationId: string
  dialogId: string
  baseSeq: number
  ops: DialogOp[]
  snapshot: DialogSnapshot
  /** Optional human-facing "why" the agent changed it (surfaced in D2). */
  rationale?: string
}

/** Agent reopened a closed dialog into its persisted live state. */
export interface DialogReopenMessage {
  type: 'dialog_reopen'
  conversationId: string
  dialogId: string
  snapshot: DialogSnapshot
}

/** A live dialog was orphaned (agent gone: /clear, conversation end). Becomes
 *  read-only; not reopenable. */
export interface DialogOrphanedMessage {
  type: 'dialog_orphaned'
  conversationId: string
  dialogId: string
  reason: string
  snapshot: DialogSnapshot
}

/** Panel -> broker -> host: a user interaction on a live dialog (D1c).
 *  The PANEL sends it without `seq`; the BROKER stamps a monotonic per-dialog
 *  `seq` before forwarding to the host. `state` is the FULL client-side input
 *  snapshot. `handlerId` is the caller's correlation mnemonic (or '__close__'
 *  / '__submit__' reserved markers). D1c routes + guards + forwards; the host
 *  turn DELIVERY (and the renderer that emits this) lands in D2. */
export interface DialogEventMessage {
  type: 'dialog_event'
  conversationId: string
  dialogId: string
  seq: number
  handlerId: string
  on: 'click' | 'change' | 'submit' | 'close'
  value?: unknown
  state: Record<string, unknown>
  [key: string]: unknown // WS JSON boundary (requestId echo etc.)
}

/** Panel -> broker: AUTHORITATIVE dismiss of a live dialog. Unlike minimize (a
 *  per-viewer client-side preference in localStorage), a dismiss is a real
 *  decision: the broker DROPS the live slot so it never replays again, for any
 *  viewer. Gated by `dialog:interact` (read-only viewers cannot dismiss). The
 *  agent can re-engage by patching/reopening, which recreates the slot. */
export interface DialogLiveDismissMessage {
  type: 'dialog_live_dismiss'
  conversationId: string
  dialogId: string
  [key: string]: unknown // WS JSON boundary (requestId echo etc.)
}

/** Broker -> panels: a live dialog was authoritatively dismissed (slot dropped).
 *  Every panel removes it from view. */
export interface DialogLiveDismissedMessage {
  type: 'dialog_live_dismissed'
  conversationId: string
  dialogId: string
}

// Plan approval relay (headless: ExitPlanMode -> agent host -> broker -> dashboard -> back)
export interface PlanApprovalRequest {
  type: 'plan_approval'
  conversationId: string
  requestId: string // control_request request_id from CC
  toolUseId?: string
  plan: string // the plan content (markdown)
  planFilePath?: string
  allowedPrompts?: string[]
}

export interface PlanApprovalResponse {
  type: 'plan_approval_response'
  conversationId: string
  requestId: string
  toolUseId?: string
  action: 'approve' | 'reject'
  feedback?: string // rejection reason, fed to the agent as the deny message (action === 'reject')
  [key: string]: unknown // WS JSON boundary
}

export interface PlanModeChanged {
  type: 'plan_mode_changed'
  conversationId: string
  planMode: boolean
}

// Permission relay (CC -> channel -> dashboard -> channel -> CC)
export interface PermissionRequest {
  type: 'permission_request'
  conversationId: string
  requestId: string // request_id from CC's control_request
  toolName: string
  description: string
  inputPreview: string // JSON.stringify(input), truncated to 200 chars
  toolUseId?: string // tool_use_id from CC, needed for control_response
}

export interface PermissionResponse {
  type: 'permission_response'
  conversationId: string
  requestId: string
  behavior: 'allow' | 'deny'
  toolUseId?: string
}

// Broker -> dashboard broadcast: a pending permission request was resolved (by
// any session). Tells every other subscriber to drop the permission prompt.
// Mirror of ask_dismiss / dialog_dismiss for the permission flow.
export interface PermissionDismiss {
  type: 'permission_dismiss'
  conversationId: string
  requestId: string
}

export type BrokerMessage =
  | Ack
  | BrokerError
  | ProtocolUpgradeRequired
  | SendInput
  | TerminalAttach
  | TerminalDetach
  | TerminalData
  | TerminalResize
  | TranscriptRequest
  | SubagentTranscriptRequest
  | FileRequest
  | ProjectBoardRequest
  | ProjectFileRequest
  | ProjectSubscribe
  | ProjectUnsubscribe
  | TranscriptKick
  | InterConversationDelivery
  | SystemChannelDelivery
  | DispatchDecision
  | DispatchRequestResult
  | DispatchToolCall
  | DispatchToolResult
  | DispatchThreadsResult
  | DispatchHistoryMessage
  | ProjectLinkRequest
  | ProjectLinkGranted
  | InterConversationListResponse
  | SendInterrupt
  | PermissionResponse
  | AskQuestionResponse
  | QuitConversation
  | QuitLineage
  | ConversationTerminated
  | ConversationControl
  | ControlDeliver
  | ConversationReassign
  | ConversationReassignResult
  | ConversationReassigned
  | DialogResultMessage
  | DialogEventMessage
  | DialogLiveDismissMessage
  | PlanApprovalResponse
  | NotifyConfigUpdated
  | RclaudeConfigGet
  | RclaudeConfigSet
  | JsonStreamAttach
  | JsonStreamDetach
  | MarkAllTasksDone
  | ConversationStatusTransition
  | SocketReplaced
  | PhantomReapCandidate
  | DaemonControlResult
  | DaemonRosterForward
  | DaemonRespawnStaleRequest
  | DebugControlSend
  | DebugTraceEvent
  | DebugControlResult
  | WebControlRequest
  | WebControlAdvertise
  | WebControlRevoke
  | WebControlResponse
  | WebControlRelayResponse
  | ChecklistListRequest
  | ChecklistCreateRequest
  | ChecklistSetStatusRequest
  | ChecklistUpdateRequest
  | ChecklistDeleteRequest
  | ChecklistReplaceRequest
  | ChecklistArchiveRequest
  | ChecklistPurgeRequest
  | NightshiftRequest

export interface NotifyConfigUpdated {
  type: 'notify_config_updated'
}

// ─── Web Debug Control ──────────────────────────────────────────────────
// Agent-driven remote control of a LIVE control-panel browser (the "web
// debugger"). An opted-in browser advertises a stable clientId + a time-boxed
// grant; broker MCP tools (web_*) target that clientId, send a web_control_request
// over its socket, and await the matching web_control_response. Default-deny:
// a browser that has not advertised an unexpired grant is never targeted, and
// the browser itself refuses every op without a live local grant. See
// .claude/docs/plan-web-debug-control.md.

/** The fixed set of control ops a browser can execute on the agent's behalf. */
export const WEB_CONTROL_OPS = [
  'screenshot',
  'list_commands',
  'execute_command',
  'set_conversation',
  'read_transcript',
  'send_prompt',
  // Host-shell terminal control (driven detached / off-screen).
  'terminal_list',
  'terminal_start',
  'terminal_attach',
  'terminal_detach',
  'terminal_read',
  'terminal_write',
  'terminal_screenshot',
  // Performance monitor (the "Details for Nerds" perf HUD).
  'perf_report',
  'set_perf_monitor',
  // Arbitrary JS eval in the browser. STRICTLY gated: a SEPARATE "Allow script
  // execution" opt-in (advertised only when that toggle is on), benevolent-only
  // at the relay, host-MCP-only (never the external broker MCP), and audited.
  'execute_script',
] as const
export type WebControlOp = (typeof WEB_CONTROL_OPS)[number]

/** Hard ceiling on a control grant's lifetime. The broker clamps any advertised
 *  expiresAt to now + this, so a buggy/hostile client cannot extend its window. */
export const WEB_CONTROL_MAX_GRANT_MS = 60 * 60 * 1000 // 1 hour

/** web -> broker: a browser opts in (or re-advertises after reconnect/reload).
 *  Sent on every (re)connect while a non-expired grant exists in localStorage. */
export interface WebControlAdvertise {
  type: 'web_control_advertise'
  /** Stable per-browser id (localStorage, survives reload). The agent targets THIS. */
  clientId: string
  /** Per-grant id (rotates each opt-in). For audit/correlation only. */
  grantId: string
  /** Epoch ms when the grant expires. Broker clamps to now + WEB_CONTROL_MAX_GRANT_MS. */
  expiresAt: number
  /** Ops this browser is willing+able to perform. */
  capabilities: WebControlOp[]
  /** Human label for the agent's client picker (e.g. "Jonas - MacBook / Chrome"). */
  label?: string
}

/** web -> broker: a browser opts out early (toggle off / grant cleared). */
export interface WebControlRevoke {
  type: 'web_control_revoke'
  clientId: string
}

/** broker -> web: execute one op. The browser must re-check its live local grant
 *  before acting and reply with a web_control_response carrying the same requestId. */
export interface WebControlRequest {
  type: 'web_control_request'
  requestId: string
  clientId: string
  op: WebControlOp
  args: Record<string, unknown>
}

/** web -> broker: result of a web_control_request, matched by requestId. */
export interface WebControlResponse {
  type: 'web_control_response'
  requestId: string
  ok: boolean
  result?: unknown
  error?: string
}

/** agent host -> broker: relay a web-control op (or list_clients) to the broker's
 *  web-control registry on behalf of an in-process agent. The broker resolves the
 *  target browser (explicit clientId or the implicit single opted-in client), runs
 *  the op via sendWebControlRequest, and replies with web_control_relay_response
 *  carrying the same requestId. This bridges the HOST MCP site to the broker-only
 *  web-control registry (Phase 5 of plan-mcp-toolset-unification.md) -- the broker
 *  remains the sole owner of grant state; the agent host just forwards. */
export interface WebControlRelayRequest {
  type: 'web_control_relay'
  requestId: string
  /** Explicit target browser; omit to let the broker resolve the implicit single client. */
  clientId?: string
  /** 'list_clients' (broker-local registry read) or a WebControlOp to run on the browser. */
  op: 'list_clients' | WebControlOp
  /** Op arguments (ignored for list_clients). */
  args?: Record<string, unknown>
}

/** broker -> agent host: result of a web_control_relay, matched by requestId.
 *  For op='list_clients', result is WebControlClientInfo[]. */
export interface WebControlRelayResponse {
  type: 'web_control_relay_response'
  requestId: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface SendInterrupt {
  type: 'interrupt'
  conversationId: string
}

/**
 * Termination source taxonomy.
 *
 * Every call that flips a conversation to `status: 'ended'` MUST tag itself
 * with one of these values. The broker writes a row to the daily-rotated
 * NDJSON termination log keyed by source + initiator. Use the broker-cli
 * `termination` subcommand to grep history.
 *
 * Adding a new source? Update:
 *   1. This enum
 *   2. broker-cli help in `cli/shared.ts`
 *   3. README termination section
 */
export type TerminationSource =
  // Dashboard-initiated kills (web client)
  | 'dashboard-context-menu' // sidebar right-click -> Terminate
  | 'dashboard-terminate-dialog' // explicit confirm dialog
  | 'dashboard-lineage' // "terminate full lineage" subtree kill (per-member tag)
  | 'dashboard-terminate-project' // project context menu "Terminate all" (per-member tag)
  | 'dashboard-launch-toast' // launch-profile toast "Cancel launch" button
  | 'dashboard-other' // fallback for legacy/unknown dashboard callers
  // Inter-conversation
  | 'inter-conversation-restart' // another conversation issued channel_restart
  // Agent host -- intentional shutdown
  | 'mcp-exit-session' // agent self-terminated via mcp__rclaude__exit_session
  | 'headless-input' // user typed /exit /quit :q :q! into headless stdin
  // Agent host -- CC process events
  | 'cc-exit-normal' // CC exited code 0
  | 'cc-exit-crash' // CC exited non-zero or by signal
  // Broker-driven cleanup
  | 'ws-close' // last live agent host socket closed without explicit `end`
  | 'reaper-phantom' // 30s reaper: no live sockets remaining
  | 'nightshift-watchdog' // deterministic nightshift watchdog: a per-task cap breach (time/token/idle/turn) or capacity-floor yield
  // Broker-driven RESURRECTION (used with kind='unend' to log a flap signal,
  // not an actual termination -- a previously-ended conversation got
  // un-ended because `meta` or `agent_host_boot` arrived for it).
  | 'broker-unend' // status flipped from 'ended' back to active (flap)
  // Daemon-mirrored sessions (read-only `claude agents` mirror)
  | 'daemon-job-gone' // a mirrored daemon job reached a terminal state or left the roster
  // Future-facing
  | 'sentinel-kill' // explicit sentinel kill (not yet wired)
  | 'unknown' // legacy paths until tagged

export interface TerminationDetail {
  ccExitCode?: number
  ccSessionId?: string
  agentHostPid?: number
  /** Last hook timestamp seen before termination. */
  lastActivityAt?: number
  /** Free-form message (e.g. "stdin EOF after CC exited"). */
  note?: string
  /** Status the conversation held just BEFORE this termination/transition fired. */
  statusBefore?: 'active' | 'idle' | 'ended' | 'starting' | 'booting'
  /** Live socket count BEFORE the cleanup that triggered this record. */
  liveSocketsBefore?: number
  /** ms between `lastActivity` and the record timestamp. Helps spot half-dead conversations. */
  lastActivityAgoMs?: number
  /** Agent host version string (rclaude/HASH) for cross-deploy correlation. */
  hostVersion?: string
  /**
   * Resolved sentinel-profile name (`conv.resolvedProfile`) at time of death.
   * Absent for default-profile conversations. Required when reviewing
   * quota-exhaustion bugs offline: without it you cannot tell which account
   * died from the NDJSON alone. NAME only, never credentials/configDir.
   */
  profile?: string
  /**
   * Discriminator. Default 'termination'. 'unend' records are appended when
   * `resumeConversation` flips a previously-`ended` conversation back to
   * `idle` (the flap signal) -- they share the schema for one-file greppability.
   */
  kind?: 'termination' | 'unend'
}

export interface QuitConversation {
  type: 'terminate_conversation'
  conversationId: string
  /** Where the kill came from. Web clients must populate this. */
  source?: TerminationSource
  /** Optional override of initiator (defaults to ctx.ws.data principal). */
  initiator?: string
}

/**
 * Terminate a whole spawn-lineage subtree in one shot (dashboard -> broker).
 * The broker walks `conversationId` plus every descendant (following
 * `parentConversationId` edges in the store), then terminates each member
 * that is still alive (status !== 'ended'). Already-ended members are skipped;
 * members in a project the caller lacks `chat` on are skipped. Each individual
 * termination still emits its own `conversation_status_transition` /
 * `conversation_terminated`, so the UI sees the fan-out conversation by
 * conversation -- this message is just the batch trigger.
 */
export interface QuitLineage {
  type: 'terminate_lineage'
  /** Subtree root to terminate: this conversation + all its descendants. */
  conversationId: string
  /** Where the kill came from. Web clients must populate this. */
  source?: TerminationSource
  /** Optional override of initiator (defaults to ctx.ws.data principal). */
  initiator?: string
}

/**
 * Broadcast to dashboard when a conversation terminates. Carries
 * source/initiator/detail so the UI can render a badge and an inline
 * transcript timeline entry. The legacy `conversation_ended` event still
 * fires for backwards-compat status updates.
 */
export interface ConversationTerminated {
  type: 'conversation_terminated'
  conversationId: string
  source: TerminationSource
  initiator?: string
  detail?: TerminationDetail
  endedAt: number
}

/**
 * Broker -> dashboard. Fired on EVERY conversation status flip (NOT just
 * end-state ones). Dashboard renders an inline transcript timeline entry;
 * broker persists it. The single chokepoint for "did the status change,
 * who/what caused it, what came before".
 */
export interface ConversationStatusTransition {
  type: 'conversation_status_transition'
  conversationId: string
  from: 'active' | 'idle' | 'ended' | 'starting' | 'booting'
  to: 'active' | 'idle' | 'ended' | 'starting' | 'booting'
  /** Free-form but specific: 'meta-resume', 'meta-on-ended', 'boot-new',
   *  'boot-on-active', 'reaper-no-sockets', 'ws-close-empty', 'end-handler',
   *  'conversation_status-signal', etc. */
  reason: string
  source?: TerminationSource | string
  initiator?: string
  /** Socket count AFTER the transition. */
  liveSockets: number
  /** Last known ccSessionId (informational only, never used for routing). */
  ccSessionId?: string
  /** ms since lastActivity at the moment of transition. */
  lastActivityAgoMs?: number
  at: number
}

/**
 * Broker -> dashboard. Fired when setConversationSocket replaces an
 * existing socket under the same (conv, conn) key with a different ws.
 * Silently overwriting a live socket is how the boot/meta race becomes
 * an invisible flap; this event surfaces it.
 */
export interface SocketReplaced {
  type: 'socket_replaced'
  conversationId: string
  connectionId: string
  /** WebSocket.readyState of the socket being replaced. */
  oldReadyState: number
  /** Buffered outbound bytes on the socket being replaced (lossiness hint). */
  oldBufferedAmount?: number
  /** WebSocket.readyState of the new socket. */
  newReadyState: number
  /** Initial wire message type that drove the replacement: 'meta', 'agent_host_boot', etc. */
  via: string
  at: number
}

/**
 * Broker -> dashboard. Fired EVERY reaper tick for a conversation the
 * reaper considered (status !== ended, requiresAgentSocket). `willEnd`
 * is true on the tick the reaper is about to end the conversation,
 * false for survivors -- both are valuable: a conversation that
 * survives the reaper repeatedly is a flapping conversation.
 */
export interface PhantomReapCandidate {
  type: 'phantom_reap_candidate'
  conversationId: string
  status: 'active' | 'idle' | 'starting' | 'booting'
  liveSockets: number
  willEnd: boolean
  /** ms since lastActivity. */
  lastActivityAgoMs: number
  ccSessionId?: string
  at: number
}

export interface RecapRequest {
  type: 'recap_request'
  conversationId: string
}

/**
 * Higher-level control verbs routed to a target session's agent host. The agent host
 * interprets these backend-specifically (headless vs PTY) instead of letting
 * the text reach the model. Used by:
 *   - dashboard input: when user types a bare `/clear`, `/quit`, `:q`, etc.
 *   - inter-session MCP `control_session` tool
 */
export type ConversationControlAction =
  | 'clear'
  | 'quit'
  | 'interrupt'
  | 'set_model'
  | 'set_effort'
  | 'set_permission_mode'

export interface ConversationControl {
  type: 'conversation_control'
  targetConversation: string
  action: ConversationControlAction
  fromConversation?: string
  model?: string // required when action === 'set_model'
  effort?: string // required when action === 'set_effort' (low|medium|high|xhigh|max|auto)
  permissionMode?: string // required when action === 'set_permission_mode'
  /** Optional batch correlation id for fan-out from batch command palette.
   *  Broker logs it; never interpreted. */
  batchId?: string
}

export interface ConversationControlResult {
  type: 'conversation_control_result'
  ok: boolean
  action?: ConversationControlAction
  name?: string
  error?: string
}

/** Broker -> agent host: execute a control verb against the local CC. */
export interface ControlDeliver {
  type: 'control'
  action: ConversationControlAction
  model?: string
  effort?: string
  permissionMode?: string
  fromConversation?: string
}

/**
 * Client -> broker: rewrite a conversation's persisted routing metadata
 * (projectUri / hostSentinelId / resolvedProfile). Future launch + revive
 * picks up the new target. The currently-running process is NOT migrated;
 * it keeps running on its current sentinel until it dies naturally.
 *
 * IDENTITY MODEL covenant: conversationId and ccSessionId NEVER change here.
 * BOUNDARY covenant: broker mutates Conversation fields; agentHostMeta is
 * still opaque.
 *
 * Permission: admin on both the source AND the target project.
 *
 * Each provided field is applied independently. Omit a field to leave it
 * unchanged. Pass null for hostSentinelId / profile to clear back to default.
 */
export interface ConversationReassign {
  type: 'conversation_reassign'
  targetConversation: string
  toProjectUri?: string
  toHostSentinelId?: string | null
  toProfile?: string | null
  /** Optional batch correlation id for fan-out from batch command palette. */
  batchId?: string
}

export interface ConversationReassignResult {
  type: 'conversation_reassign_result'
  ok: boolean
  conversationId?: string
  error?: string
}

/** Broker -> subscribers: a reassign was applied. Rendered in transcript per
 *  the Everything-is-a-Structured-Message covenant so the user sees the
 *  routing change. */
export interface ConversationReassigned {
  type: 'conversation_reassigned'
  conversationId: string
  prev: {
    projectUri: string
    hostSentinelId?: string | null
    resolvedProfile?: string | null
  }
  next: {
    projectUri: string
    hostSentinelId?: string | null
    resolvedProfile?: string | null
  }
  at: number
  /** Optional batch correlation id. */
  batchId?: string
}

// Hook event types from Claude Code
export type HookEventType =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'Stop'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'PermissionRequest'
  | 'TeammateIdle'
  | 'TaskCompleted'
  | 'InstructionsLoaded'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'StopFailure'
  | 'Setup'
  | 'CwdChanged'
  | 'FileChanged'
  | 'TaskCreated'
  | 'PermissionDenied'

// Hook event data structures (based on Claude Code hook system)
export interface SessionStartData {
  session_id: string
  cwd: string
  model?: string
  source?: string
  transcript_path?: string
}

export interface UserPromptSubmitData {
  session_id: string
  prompt: string
}

export interface PreToolUseData {
  session_id: string
  tool_name: string
  tool_input: Record<string, unknown>
}

export interface PostToolUseData {
  session_id: string
  tool_name: string
  tool_input: Record<string, unknown>
  tool_response?: string | Record<string, unknown>
}

export interface PostToolUseFailureData {
  session_id: string
  tool_name: string
  tool_input: Record<string, unknown>
  error: string
}

export interface NotificationData {
  session_id: string
  message: string
  notification_type?: string
}

export interface StopData {
  session_id: string
  reason?: string
}

export interface SessionEndData {
  session_id: string
  reason?: string
}

export interface SubagentStartData {
  session_id: string
  agent_id?: string
  agent_type?: string
}

export interface SubagentStopData {
  session_id: string
  agent_id?: string
  transcript?: string
  agent_type?: string
  agent_transcript_path?: string
  stop_hook_active?: boolean
}

export interface TeammateIdleData {
  session_id: string
  agent_id?: string
  agent_name?: string
  team_name?: string
}

export interface TaskCompletedData {
  session_id: string
  task_id?: string
  task_subject?: string
  owner?: string
  team_name?: string
}

export interface SetupData {
  session_id: string
  [key: string]: unknown
}

export interface PreCompactData {
  session_id: string
  trigger: string
}

export interface PostCompactData {
  session_id: string
  trigger?: string
}

export interface PermissionRequestData {
  session_id: string
  tool?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  suggestions?: string[]
}

export interface PermissionDeniedData {
  session_id: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  reason?: string
}

export interface StopFailureData {
  session_id: string
  stop_reason?: string
  error_type?: string
  error_message?: string
  error?: string
  // CC compatibility: some versions emit camelCase variants
  stopReason?: string
  errorType?: string
  errorMessage?: string
}

export interface ElicitationData {
  session_id: string
  message?: string
  schema?: Record<string, unknown>
}

export interface ElicitationResultData {
  session_id: string
  result?: unknown
}

export interface CwdChangedData {
  session_id: string
  cwd?: string
}

export interface FileChangedData {
  session_id: string
  path?: string
}

export interface TaskCreatedData {
  session_id: string
  task_id?: string
  description?: string
}

export interface InstructionsLoadedData {
  session_id: string
  source?: string
}

export interface ConfigChangeData {
  session_id: string
  key?: string
  value?: unknown
}

export interface WorktreeCreateData {
  session_id: string
  name?: string
  cwd?: string
  path?: string
}

export interface WorktreeRemoveData {
  session_id: string
  path?: string
}

export type HookEventData =
  | SessionStartData
  | UserPromptSubmitData
  | PreToolUseData
  | PostToolUseData
  | PostToolUseFailureData
  | NotificationData
  | StopData
  | StopFailureData
  | SessionEndData
  | SubagentStartData
  | SubagentStopData
  | PreCompactData
  | PostCompactData
  | PermissionRequestData
  | PermissionDeniedData
  | TeammateIdleData
  | TaskCompletedData
  | SetupData
  | ElicitationData
  | ElicitationResultData
  | CwdChangedData
  | FileChangedData
  | TaskCreatedData
  | InstructionsLoadedData
  | ConfigChangeData
  | WorktreeCreateData
  | WorktreeRemoveData
  | Record<string, unknown>

/**
 * Maps each HookEventType to its typed payload shape. Used by HookEventOf<T>
 * so per-event handlers can narrow `event.data` without ad-hoc casts.
 */
export interface HookEventDataMap {
  SessionStart: SessionStartData
  UserPromptSubmit: UserPromptSubmitData
  PreToolUse: PreToolUseData
  PostToolUse: PostToolUseData
  PostToolUseFailure: PostToolUseFailureData
  Notification: NotificationData
  Stop: StopData
  StopFailure: StopFailureData
  SessionEnd: SessionEndData
  SubagentStart: SubagentStartData
  SubagentStop: SubagentStopData
  PreCompact: PreCompactData
  PostCompact: PostCompactData
  PermissionRequest: PermissionRequestData
  PermissionDenied: PermissionDeniedData
  TeammateIdle: TeammateIdleData
  TaskCompleted: TaskCompletedData
  InstructionsLoaded: InstructionsLoadedData
  ConfigChange: ConfigChangeData
  WorktreeCreate: WorktreeCreateData
  WorktreeRemove: WorktreeRemoveData
  Elicitation: ElicitationData
  ElicitationResult: ElicitationResultData
  Setup: SetupData
  CwdChanged: CwdChangedData
  FileChanged: FileChangedData
  TaskCreated: TaskCreatedData
}

/**
 * Narrowed HookEvent for a specific hook-event family. Use after a
 * discriminated check on `event.hookEvent` so per-event handlers get
 * `event.data` typed precisely. Distributive over T so a union like
 * `HookEventOf<'Stop' | 'StopFailure'>` becomes `HookEventOf<'Stop'> |
 * HookEventOf<'StopFailure'>` -- discriminated unions narrow correctly
 * on `event.hookEvent` checks.
 */
export type HookEventOf<T extends HookEventType> = T extends HookEventType
  ? Omit<HookEvent, 'hookEvent' | 'data'> & {
      hookEvent: T
      data: T extends keyof HookEventDataMap ? HookEventDataMap[T] : Record<string, unknown>
    }
  : never

// Sub-agent tracking
export interface SubagentInfo {
  agentId: string
  agentType: string
  description?: string
  /** Cheap roster-card field captured at PreToolUse(Agent). The big launch
   *  prompt/args live in the agent sub-stream's launch entry, never here. */
  model?: string
  startedAt: number
  stoppedAt?: number
  status: 'running' | 'stopped'
  transcriptPath?: string
  events: HookEvent[]
  tokenUsage?: {
    totalInput: number
    totalOutput: number
    cacheCreation: number
    cacheRead: number
  }
}

// Team tracking
export interface TeamInfo {
  teamName: string
  role: 'lead' | 'teammate'
}

export interface TeammateInfo {
  agentId: string
  name: string
  teamName: string
  status: 'idle' | 'working' | 'stopped'
  startedAt: number
  stoppedAt?: number
  currentTaskId?: string
  currentTaskSubject?: string
  completedTaskCount: number
}

// Background command tracking
export interface BgTaskInfo {
  taskId: string
  command: string
  description: string
  startedAt: number
  completedAt?: number
  status: 'running' | 'completed' | 'killed'
}

// Monitor (background watch) tracking
export interface MonitorInfo {
  taskId: string
  toolUseId: string
  description: string
  command?: string
  persistent?: boolean
  timeoutMs?: number
  startedAt: number
  stoppedAt?: number
  status: 'running' | 'completed' | 'timed_out' | 'failed'
  eventCount: number
}

// Monitor lifecycle events (agent host -> broker)
export interface MonitorUpdate {
  type: 'monitor_update'
  conversationId: string
  monitor: MonitorInfo
}

// Scheduled task fire event (agent host -> broker, distinct from transcript entry)
export interface ScheduledTaskFire {
  type: 'scheduled_task_fire'
  conversationId: string
  content: string
  timestamp: number
}

// Per-project customization settings (label, icon, color, keyterms)
export interface ProjectSettings {
  label?: string
  icon?: string
  color?: string
  description?: string // user-provided purpose, shown in list_conversations for routing
  keyterms?: string[]
  trustLevel?: 'default' | 'open' | 'benevolent' // open = accepts from anyone, benevolent = can message anyone
  defaultLaunchMode?: 'headless' | 'pty'
  defaultEffort?: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' // 'default' = don't pass --effort flag
  defaultModel?: string // model alias or full name (e.g. 'sonnet', 'opus', 'claude-sonnet-4-7')
  // Spawn dialog defaults (override global)
  defaultBare?: boolean
  defaultRepl?: boolean
  defaultPermissionMode?: 'default' | 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions'
  defaultAutocompactPct?: number // 0 = use CC default
  defaultMaxBudgetUsd?: number // 0 = no limit
  defaultIncludePartialMessages?: boolean // default: true. Set false to disable token streaming
  defaultEnvText?: string
  /** Default OpenCode tool permission tier for spawns from this project.
   *  - 'none' = pure chat, no tools
   *  - 'safe' = read-only tools (read, glob, grep, ls, webfetch); no bash/write/edit
   *  - 'full' = all tools including bash + write + edit (uses --dangerously-skip-permissions)
   *  Unset = treated as 'safe' at spawn time. */
  defaultOpenCodeToolPermission?: 'none' | 'safe' | 'full'
  /** Default OpenCode model for spawns from this project (e.g. 'opencode-go/glm-5.1',
   *  'openrouter/anthropic/claude-haiku-4.5'). Empty/unset = fall back to global default,
   *  then to OPENCODE_FALLBACK_MODEL ('opencode-go/glm-5.1'). */
  defaultOpenCodeModel?: string
  allowPlanMode?: boolean // default: true. Set false to auto-deny EnterPlanMode
  verbs?: string[] // custom spinner verbs (merged with defaults)
  pinned?: boolean
  /** Lessons-Learned Scavenger ("Overwatch") opt-in. When true the nightly
   *  scavenger produces a lessons-learned recap for this project. Default off
   *  (opt-in). [[project_lessons_scavenger]] */
  lessonsEnabled?: boolean
  /** Epoch ms of the last successful nightly lessons scavenge for this project.
   *  Used only for activity-gating / observability; the window is a fixed
   *  rolling 7d, so this is not a strict watermark. */
  lessonsLastRun?: number
}

// File metadata for the file editor
export interface FileInfo {
  path: string
  name: string
  size: number
  modifiedAt: number
}

/**
 * Strict per-kind status enums. The agent host normalizes raw input from the
 * source (CC's TodoWrite tool, project board files, etc.) into these values
 * before sending over the wire. Anything outside the enum gets coerced to a
 * default ('pending' for todo, 'open' for project) with a debug warn so the
 * broker never has to reason about unexpected statuses.
 */
export type TodoTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'
export type ProjectTaskStatus = 'inbox' | 'open' | 'in-progress' | 'in-review' | 'done' | 'archived'
export type TaskStatus = TodoTaskStatus | ProjectTaskStatus

/** Source/flavor of a task. Determines which status enum applies and which UI renders it. */
export type TaskKind = 'todo' | 'project'

// Conversation state in broker
export interface TaskInfo {
  id: string
  subject: string
  description?: string
  status: TaskStatus
  kind?: TaskKind // optional for back-compat; defaults to 'todo' when absent
  priority?: number
  blockedBy?: string[]
  blocks?: string[]
  owner?: string
  updatedAt: number
  completedAt?: number
  /** Catch-all for kind-specific extras (e.g. project board path, tags). */
  data?: Record<string, unknown>
}

export interface ArchivedTaskGroup {
  archivedAt: number
  tasks: TaskInfo[]
}

export interface Conversation {
  id: string // conversationId -- stable primary key, survives /clear
  agentHostMeta?: Record<string, unknown> // opaque bag from agent host (ccSessionId lives here, broker never reads it)
  project: string // project URI identity (e.g. "claude:///Users/jonas/projects/foo")
  /**
   * Direct spawner conversationId, captured at first persistence from the
   * rendezvous registry. NULL/undefined = self-rooted (human-started). Set
   * ONCE on the conversation's first INSERT; never overwritten by revive,
   * /clear, or restart. See `.claude/docs/plan-spawn-parent-tracking.md`.
   */
  parentConversationId?: string
  /**
   * Topmost ancestor in the spawn chain. For an A->B->C chain, all three of
   * B and C carry `rootConversationId = A.id`; A itself has no root. Computed
   * at insert time (parent.rootConversationId ?? parent.id) so the UI grouping
   * key is a column lookup rather than a recursive walk.
   */
  rootConversationId?: string
  /**
   * Sentinel-profile NAME the sentinel resolved for this conversation. Set by
   * spawn_result.resolvedProfile / revive_result.resolvedProfile. Pinned for
   * the life of the conversation -- revive forwards this same name back.
   * `undefined` means default profile (the implicit one when no profile is set).
   * PROFILE-ENV BOUNDARY: the broker stores the NAME only, never configDir / env.
   */
  resolvedProfile?: string
  currentPath?: string // where Claude is currently working (CwdChanged hook)
  model?: string
  configuredModel?: string // the --model value passed to CC (preserves [1m] suffix that CC strips)
  args?: string[]
  capabilities?: AgentHostCapability[]
  transcriptPath?: string
  version?: string
  buildTime?: string
  agentHostType?: string
  /** Resolved transport for this conversation (the wire mechanism driving the
   *  backend): 'claude-pty' | 'claude-headless' | 'claude-daemon'. Set at spawn
   *  by resolveSpawnConfig. `agentHostType` stays as a redundant display proxy
   *  until Phase 5 of the transport reframe. */
  transport?: string
  /** Backend-specific opaque bag (parallel to agentHostMeta). The broker core
   *  NEVER reads or branches on this -- only a backend implementation does.
   *  See `.claude/docs/plan-claude-transport-reframe.md` § 0.3. */
  transportMeta?: Record<string, unknown>
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
  startedAt: number
  lastActivity: number
  /** Last time a MESSAGE was posted to this conversation (a user prompt /
   *  impulse), distinct from `lastActivity` which ticks on every hook event.
   *  Stamped on UserPromptSubmit; drives the "impulse age" in list_conversations. */
  lastInputAt?: number
  status: 'active' | 'idle' | 'ended' | 'starting' | 'booting'
  compacting?: boolean
  compactedAt?: number
  events: HookEvent[]
  subagents: SubagentInfo[]
  tasks: TaskInfo[]
  archivedTasks: ArchivedTaskGroup[]
  bgTasks: BgTaskInfo[]
  monitors: MonitorInfo[]
  teammates: TeammateInfo[]
  team?: TeamInfo
  diagLog: Array<{ t: number; type: string; msg: string; args?: unknown }>
  effortLevel?: string // 'speed' field from API usage: e.g. 'standard', maps to low/medium/high
  conversationInfo?: {
    tools?: unknown[]
    slashCommands?: unknown[]
    skills?: unknown[]
    agents?: unknown[]
    mcpServers?: Array<{ name: string; status?: string }>
    plugins?: unknown[]
    model?: string
    permissionMode?: string
    claudeCodeVersion?: string
    fastModeState?: unknown
  }
  permissionMode?: string // current CC permission mode (default/plan/acceptEdits/auto/bypassPermissions)
  lastError?: { stopReason?: string; errorType?: string; errorMessage?: string; timestamp: number }
  /**
   * Set ONLY for actual rate limits (CC sent retry_after_ms). NOT set for
   * notices (7-day soft warnings) -- the toast surfaces those instead.
   */
  rateLimit?: {
    retryAfterMs?: number
    /** Epoch ms when the bucket resets (live formatter source). */
    resetsAt?: number
    message: string
    timestamp: number
    /** Resolved sentinel-profile name -- which account hit the limit. */
    profile?: string
    /** Sentinel hosting that profile (broker-internal correlation key). */
    sentinelId?: string
    /** Denormalized human-readable sentinel alias for UI display. */
    sentinelAlias?: string
  }
  pendingAttention?: {
    type: 'permission' | 'elicitation' | 'ask' | 'dialog' | 'plan_approval' | 'spawn_approval'
    toolName?: string
    filePath?: string
    question?: string
    timestamp: number
  }
  /**
   * Set when status transitions to 'ended'. Surfaces to the UI as a badge.
   * Same data is written to the daily-rotated NDJSON termination log.
   */
  endedBy?: {
    source: TerminationSource
    initiator?: string
    at: number
    detail?: TerminationDetail
  }
  planMode?: boolean // true when conversation is in plan mode (EnterPlanMode approved, not yet exited)
  hasNotification?: boolean // unread notification (cleared when conversation is viewed)
  pendingDialog?: { dialogId: string; layout: DialogLayout; timestamp: number; expired?: boolean }
  /**
   * THE DIALOGUE — a single live/persistent dialog (D1c). Distinct from the
   * one-shot `pendingDialog`: this one survives across turns, is patched in
   * place, and is reopenable. The `snapshot` is HOST-authoritative and the
   * broker treats it OPAQUELY (it reads only `.status`/`.dialogId`/`.seq` for
   * lifecycle routing; never layout/state/ops). Single-slot per conversation
   * (keyed multi-dialog map is a later phase). `interactor` is the first-wins
   * single-interactor lock principal; `lastEventSeq` is the broker-stamped
   * monotonic event-ordering token.
   */
  liveDialog?: {
    dialogId: string
    snapshot: DialogSnapshot
    interactor?: string
    lastEventSeq?: number
    updatedAt: number
  }
  /**
   * THE STATUS — the agent's self-reported task state (single live slot; full
   * history lives in the transcript). Set via the `set_status` MCP tool, RESET
   * to `working` on every user prompt (old `done` is stale once new work starts).
   * `state` drives the per-conversation attention badge; the text fields expand.
   */
  liveStatus?: LiveStatus
  pendingPlanApproval?: {
    requestId: string
    toolUseId?: string
    plan: string
    planFilePath?: string
    allowedPrompts?: unknown[]
    timestamp: number
  }
  pendingPermission?: {
    requestId: string
    toolName: string
    description: string
    inputPreview: string
    toolUseId?: string
    timestamp: number
  }
  pendingAskQuestion?: {
    toolUseId: string
    questions: unknown[]
    timestamp: number
  }
  /**
   * Pending spawn approval awaiting human decision in the panel. Set when a
   * non-benevolent caller invokes spawn -- the gate blocks dispatch and stores
   * the original request here. Cleared on allow/deny/expiry. Persisted as part
   * of the conversation row so it rehydrates after broker restart.
   */
  pendingSpawnApproval?: {
    requestId: string
    requestedAt: number
    /** Full original SpawnRequest payload, replayed verbatim on approval. */
    request: Record<string, unknown>
    /** Human-readable reason the gate fired. */
    reason: string
  }
  /**
   * Sticky bit set when the user ticks "allow future spawn calls from this
   * conversation". Per-CALLER, NOT per-project. Survives broker restart.
   * Future spawn requests from this conversation skip the approval prompt.
   */
  spawnAutoApproved?: boolean
  tokenUsage?: { input: number; cacheCreation: number; cacheRead: number; output: number }
  contextMode?: '1m' | 'standard' // detected from /model or /context stdout; overrides model-name heuristic
  cacheTtl?: '5m' | '1h' // dominant cache TTL tier from last turn
  lastTurnEndedAt?: number // timestamp when last turn completed (Stop hook)
  // Transcript-derived metadata (from special JSONL entry types)
  summary?: string // AI-generated conversation summary
  title?: string // custom conversation title (from /rename or auto-generated)
  titleUserSet?: boolean // true if title was explicitly set by user (spawn dialog) -- prevents auto-name overwrite
  /** Addressable slugs this conversation shed via rename, with decay bookkeeping.
   *  Lets peers that cached an OLD name keep routing for a window. Broker-owned
   *  (dedicated former_slugs column, NOT agentHostMeta). See plan-conversation-rename. */
  formerSlugs?: Array<{ slug: string; retiredAt: number; lastUsedAt: number }>
  description?: string // short user-provided line describing what this conversation is working on
  agentName?: string // agent/skill name (for --agent conversations)
  prLinks?: Array<{ prNumber: number; prUrl: string; prRepository: string; timestamp: string }>
  stats: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheCreation: number
    totalCacheWrite5m: number // 5-min TTL cache writes (1.25x input price)
    totalCacheWrite1h: number // 1-hour TTL cache writes (2.0x input price)
    totalCacheRead: number
    turnCount: number
    toolCallCount: number
    compactionCount: number
    totalCostUsd?: number
    linesAdded: number
    linesRemoved: number
    totalApiDurationMs: number
  }
  costTimeline?: Array<{ t: number; cost: number }>
  gitBranch?: string
  spinnerVerbs?: string[] // custom spinner verbs from ~/.claude/settings.json
  autocompactPct?: number // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value if set
  maxBudgetUsd?: number // --max-budget-usd value if set (headless only)
  adHocTaskId?: string // project board task slug that spawned this ad-hoc conversation
  adHocWorktree?: string // worktree branch name for ad-hoc conversations
  launchConfig?: LaunchConfig // resolved launch configuration -- reused on revive
  modelMismatch?: { requested: string; actual: string; detectedAt: number }
  resultText?: string // final result text from headless conversation (captured from stream-json result message)
  recap?: { content: string; title?: string; name?: string; timestamp: number } // away_summary recaps; name = suggested conversation name
  recapFresh?: boolean // true when no meaningful activity has occurred after the recap
  hostSentinelId?: string // which sentinel owns this conversation (from sentinel registry)
  hostSentinelAlias?: string // denormalized display alias of the sentinel
}

/**
 * Sentinel-profile selection mode at spawn time.
 *
 * - 'default'  -- pick whatever the sentinel's `defaultSelection` says (the
 *                 no-input spawn behavior; usually the literal `default` profile).
 * - 'balanced' -- sentinel picks the least-loaded profile from a pool.
 * - 'random'   -- sentinel picks a uniformly random profile from a pool.
 *
 * A literal profile NAME (e.g. `'work'`) lives alongside this type in fields
 * typed `SelectionMode | string`; the named-profile path is the "Fixed" mode.
 *
 * Balanced / Random pair with an optional `pool` field (see
 * `LaunchConfig.sentinelProfile`). When the pool is omitted at launch, the
 * sentinel substitutes its configured `defaultPool` (which itself defaults to
 * `"default"`).
 */
export type SelectionMode = 'default' | 'balanced' | 'random'

/**
 * Sentinel-reported profile metadata -- NAMES and display only, never the
 * resolved env or `configDir`. The BROKER stores these; the sentinel keeps
 * the real config (per the Profile-Env Boundary in
 * `.claude/docs/plan-sentinel-profiles.md`).
 */
export interface SentinelProfileInfo {
  /** Profile name -- addressable, `[a-z0-9-]{1,63}`. The `default` profile
   *  (`~/.claude`) is the implicit fallback when a spawn carries no profile. */
  name: string
  /** Optional human-readable label for the control panel. */
  label?: string
  /** Optional tint for the profile badge. */
  color?: string
  /** Named pool this profile belongs to (e.g. `"work"`, `"alt"`). A profile
   *  with `pool === null` is excluded from every Balanced/Random selection
   *  (Fixed-only). When the sentinel's config omits the `pool` field for a
   *  profile, the sentinel reports `pool: "default"`.
   *
   *  Balanced / Random launches filter profiles by `pool === requestedPool`
   *  (or the sentinel's `defaultPool` when the launch omits a pool). */
  pool: string | null
  /** Relative selection weight within the pool (default `1`, always `>= 0`).
   *  Balanced treats it as capacity (load divided by weight); Random picks
   *  proportionally. `weight: 0` is a soft drain -- in the pool,
   *  Fixed-addressable, never auto-picked. Display/config metadata,
   *  broker-safe (no env, no configDir). */
  weight: number
  /** Whether the sentinel believes this profile has valid Claude credentials
   *  in its `configDir`. Surfaced so the control panel can flag an un-authed
   *  profile before a spawn fails. */
  authed: boolean
  /** UI hint -- when `false`, the control panel suppresses this profile's
   *  badge on conversation rows and the launch dialog's pill text. Omitted /
   *  `true` -> render the badge normally. Set on the "ambient" profile
   *  (typically `default`) so every conversation row isn't decorated.
   *  Pure display metadata, broker-safe (no env, no configDir). */
  showLabel?: boolean
}

/** Resolved launch configuration -- stored on the conversation at spawn time, reused on revive */
export interface LaunchConfig {
  headless: boolean
  model?: string
  effort?: string
  agent?: string
  advisor?: string
  bare?: boolean
  repl?: boolean
  permissionMode?: string
  autocompactPct?: number
  maxBudgetUsd?: number
  includePartialMessages?: boolean
  env?: Record<string, string>
  appendSystemPrompt?: string
  agentHostType?: string
  /** Resolved transport for this launch (transport-reframe): 'claude-pty' |
   *  'claude-headless' | 'claude-daemon'. The control-panel-facing wire field.
   *  Daemon launch inputs (mode / settingsPath / mcpConfigPath) live in
   *  `transportMeta` -- the control panel reads the typed display fields the
   *  daemon transport copies into this struct, not the opaque bag. */
  transport?: string
  /** Daemon transport (transport === 'claude-daemon'): how the worker was
   *  launched. NOT the conversation's ccSessionId -- these are launch INPUTS
   *  the claude-daemon transport recorded so the control panel can show how a
   *  daemon conversation was started. The fork-from session id is deliberately
   *  absent -- it is session-shaped and never surfaced. */
  daemonMode?: 'new' | 'resume' | 'attach'
  daemonSettingsPath?: string
  daemonMcpConfigPath?: string
  openCodeModel?: string
  acpAgent?: string
  toolPermission?: 'none' | 'safe' | 'full'
  /**
   * Per-launch sentinel-profile INTENT -- what the user asked for at launch
   * time. Absent => no hint (sentinel picks least-loaded across all profiles).
   *
   * - `{ kind: 'profile', name }` -- user pinned an explicit named profile.
   *                                   Sentinel denies the spawn if missing.
   * - `{ kind: 'pool',    name }` -- user asked for a named pool. Sentinel
   *                                   picks the least-loaded profile within it
   *                                   and denies if the pool is empty/absent.
   *
   * The RESOLVED profile name (what the sentinel actually picked) lives on
   * the conversation record as `resolvedProfile`. The intent stays around for
   * display ("this was picked from the work pool") and re-launch-as-new.
   *
   * Profile env (API keys, `configDir`) NEVER reaches this struct -- see
   * `.claude/docs/plan-sentinel-profiles.md` Profile-Env Boundary covenant.
   */
  sentinelProfile?: { kind: 'profile'; name: string } | { kind: 'pool'; name: string }
  /**
   * NIGHTSHIFT origin tag (plan-nightshift.md §6). Present => this conversation
   * is an unattended night-run worker for `runId`/`taskId`; absent => an
   * ordinary spawn. Set from the spawn request's `nightshift` field, persisted
   * on the conversation (and reused on revive -- a revived night task is still a
   * night task), and surfaced in `ConversationSummary.launchConfig` so the
   * broker WATCHDOG can identify night tasks and the live Status screen (P3) can
   * filter rows. Carries NO capacity numbers -- those come from smart-balance.
   */
  nightshift?: { runId: string; taskId: string }
}

// ─── Launch Jobs (request-scoped event channels for spawn/revive) ────

/** Agent -> Broker: progress event during spawn/revive, tagged with jobId */
export interface LaunchLog {
  type: 'launch_log'
  jobId: string
  step: string
  /** `warn` is used for soft pre-flight findings -- non-fatal hints that may
   *  become a likely cause if the spawn then fails. UIs SHOULD render it
   *  distinctly from `error` (yellow vs red) but may fall back to `info`. */
  status: 'info' | 'ok' | 'error' | 'warn'
  detail?: string
  t: number
}

/** Structured launch lifecycle step (broker -> dashboard, first-class) */
export type LaunchStep =
  | 'job_created'
  | 'spawn_sent'
  | 'agent_acked'
  | 'agent_host_booted'
  | 'conversation_connected'
  | 'prompt_submitted'
  | 'running'
  | 'completed'
  | 'failed'

/**
 * Broker -> Control Panel: first-class launch progress event.
 * Emitted at each lifecycle step of a spawn/revive job so clients (dashboard,
 * MCP callers) see real progress instead of silence.
 */
export interface LaunchProgressEvent {
  type: 'launch_progress'
  jobId: string
  step: LaunchStep
  status: 'active' | 'done' | 'error'
  detail?: string
  t: number
  conversationId?: string
  ccSessionId?: string
  elapsed?: number
  error?: string
}

/** Broker -> Control Panel: launch job completed (session connected) */
export interface JobComplete {
  type: 'job_complete'
  jobId: string
  ccSessionId: string
  conversationId: string
}

/** Broker -> Control Panel: launch job failed */
export interface JobFailed {
  type: 'job_failed'
  jobId: string
  error: string
}

/** Optional host capabilities a sentinel advertises at registration. Distinct
 *  from `AgentHostCapability` (which is agent-host-scoped) -- these are
 *  HOST-level features the sentinel owns. See plan-host-shell.md 3.1. */
export interface SentinelFeatures {
  /** Host can spawn raw `$SHELL` PTYs (the host-shell feature). Off when
   *  `CLAUDWERK_NO_SHELL=1` / `--no-shell` / a profile-config toggle. The
   *  broker joins this onto `ConversationSummary.shellCapable` per conversation
   *  via `hostSentinelId`. */
  shell?: boolean
}

// Sentinel -> Broker messages
export interface SentinelIdentify {
  type: 'sentinel_identify'
  machineId?: string // short fingerprint (truncated SHA-256 of platform UUID/machine-id)
  hostname?: string
  alias?: string // suggested sentinel alias (first-contact only; broker may override with stored value)
  spawnRoot?: string // default directory for relative spawn paths
  /** Sentinel profiles available on this host -- NAMES + display only. The
   *  sentinel keeps the real `configDir` / env. See `SentinelProfileInfo`. */
  profiles?: SentinelProfileInfo[]
  /** What the sentinel does when a spawn arrives with no explicit profile.
   *  Defaults to `'default'` (use the `default` profile, today's behavior). */
  defaultSelection?: SelectionMode
  /** Distinct pool names across `profiles` (sorted; excludes the `null` pool
   *  i.e. excluded profiles). Sent pre-computed so the control panel can
   *  populate the pool picker without re-scanning. */
  pools?: string[]
  /** Pool the sentinel uses for Balanced/Random launches that omit a pool.
   *  Defaults to `'default'`. Configured by the sentinel's `sentinel.json`. */
  defaultPool?: string
  /** Host-level capabilities this sentinel advertises (e.g. `shell`). Absent =
   *  no extra features. See `SentinelFeatures`. */
  features?: SentinelFeatures
}

export interface ReviveResult {
  type: 'revive_result'
  ccSessionId: string // CC session ID used for --resume
  conversationId?: string // echoes the pre-assigned conversationId
  project?: string // echoed back for scoped broadcast when conversation is evicted
  jobId?: string // launch job correlation ID
  success: boolean
  error?: string
  tmuxSession?: string
  continued: boolean // true if --resume worked, false if fresh session
  /** The sentinel-profile NAME the sentinel actually resolved for this revive.
   *  A revive CAN re-target a different profile than the one the conversation
   *  last ran under (terminate on A, revive on B); the broker overwrites
   *  `conv.resolvedProfile` from this so the UI + list_conversations stop
   *  reporting the stale name. ALWAYS sent on a successful revive, INCLUDING
   *  the literal `'default'` (broker maps that back to `undefined`) so a revive
   *  to default can clear a previously-named profile. Absent => an un-rebuilt
   *  sentinel; the broker leaves the value unchanged. PROFILE-ENV BOUNDARY:
   *  NAME only, never configDir / env. */
  resolvedProfile?: string
}

export interface SpawnResult {
  type: 'spawn_result'
  requestId: string
  jobId?: string // launch job correlation ID
  success: boolean
  error?: string
  project?: string
  tmuxSession?: string
  conversationId?: string
  /** The sentinel-profile name the sentinel actually picked. For `'fixed'`
   *  spawns this is just the named profile; for `'balanced'` / `'random'`
   *  this is the sentinel's pick, which the broker writes into the stored
   *  `projectUri` userinfo so revive pins the same profile forever.
   *  Present only when the conversation runs under a non-default profile. */
  resolvedProfile?: string
}

export interface ListDirsResult {
  type: 'list_dirs_result'
  requestId: string
  dirs: string[]
  error?: string
}

export interface CcSessionEntry {
  ccSessionId: string
  title?: string
  mtime: number
  sizeBytes: number
}

export interface ListCcSessionsResult {
  type: 'list_cc_sessions_result'
  requestId: string
  ccSessions: CcSessionEntry[]
  error?: string
}

/** Broker -> Sentinel: gather git commits in `cwd` between two timestamps.
 *  The broker never touches the host FS (boundary rule) -- the sentinel runs
 *  `git log` and returns the parsed result. Backs the recap "grounding" data. */
export interface GitLogRequest {
  type: 'git_log_request'
  requestId: string
  /** Absolute path on the sentinel's filesystem. */
  cwd: string
  /** Period bounds (unix ms). Mapped to git --since / --until. */
  sinceMs: number
  untilMs: number
}

export interface GitLogCommit {
  sha: string
  isoDate: string
  author: string
  subject: string
  body: string
  filesChanged: number
  insertions: number
  deletions: number
}

/** Sentinel -> Broker: parsed git log. `success:false` + `error` when the cwd
 *  is not a git repo or git failed; `commits:[]` is a valid empty result. */
export interface GitLogResult {
  type: 'git_log_result'
  requestId: string
  cwd: string
  success: boolean
  commits: GitLogCommit[]
  error?: string
}

// ===========================================================================
// Project store RPCs (Broker <-> Sentinel)
//
// Project-scoped filesystem access runs on the SENTINEL, keyed by an absolute
// `projectRoot` (the path segment of the project URI). No conversationId, no
// live agent host required -- the board + markdown viewer work as long as the
// sentinel that owns the host is connected. The sentinel jails every path
// under `projectRoot` (see src/shared/project-store.ts). Mirrors the existing
// `list_dirs` / `git_log_request` request/result idiom.
// ===========================================================================

/** Broker -> Sentinel: read a project-relative file (markdown viewer). */
export interface ProjectReadFile {
  type: 'project_read_file'
  requestId: string
  /** Absolute project root on the sentinel's filesystem. */
  projectRoot: string
  /** Project-RELATIVE path (jailed under projectRoot). */
  relPath: string
  /** Byte cap; sentinel truncates beyond this. */
  maxBytes?: number
}

/** Sentinel -> Broker: file contents (or structured error). */
export interface ProjectReadFileResult {
  type: 'project_read_file_result'
  requestId: string
  ok: boolean
  content?: string
  size?: number
  truncated?: boolean
  error?: string
}

/** Broker -> Sentinel: write (create/overwrite) a project-relative file. */
export interface ProjectWriteFile {
  type: 'project_write_file'
  requestId: string
  projectRoot: string
  relPath: string
  content: string
}

export interface ProjectWriteFileResult {
  type: 'project_write_file_result'
  requestId: string
  ok: boolean
  size?: number
  error?: string
}

/** Broker -> Sentinel: move/rename a project-relative file. */
export interface ProjectMoveFile {
  type: 'project_move_file'
  requestId: string
  projectRoot: string
  fromRel: string
  toRel: string
}

export interface ProjectMoveFileResult {
  type: 'project_move_file_result'
  requestId: string
  ok: boolean
  error?: string
}

// ===========================================================================
// Artifact fetch RPC (Broker <-> Sentinel)
//
// Surfaces host-local artifacts (e.g. the `/insights` HTML report under a
// profile's CLAUDE_CONFIG_DIR) to a remote control panel. The report lives on
// the SENTINEL's disk under the conversation's resolved profile configDir
// (`.claude`, `.claude-work`, ...), NOT in the conversation CWD -- so the
// long-lived sentinel (not the dead-on-exit agent host, not CWD-bound
// share_file) is the right authority. The sentinel resolves configDir via
// `configDirFor(config, profile)`, jails `relPath` under it (resolveInRoot),
// AND checks it against an allowlist of glob patterns -- only whitelisted
// artifacts (default `usage-data/*.html`) are ever served. Mirrors the
// `project_read_file` request/result idiom; bytes come back base64 so the
// shape generalizes to future binary artifacts (images, pdf).
// ===========================================================================

/** Broker -> Sentinel: read a whitelisted artifact under a profile's configDir. */
export interface FetchArtifact {
  type: 'fetch_artifact'
  requestId: string
  /** Resolved profile NAME (from conv.resolvedProfile). Absent -> default
   *  profile. The sentinel maps it to a configDir locally; the broker never
   *  sees configDir (Profile-Env Boundary). */
  profile?: string
  /** configDir-RELATIVE path (jailed + allowlist-checked by the sentinel). */
  relPath: string
  /** Byte cap; sentinel rejects beyond this rather than truncating (a partial
   *  HTML report is useless). Omitted -> sentinel default. */
  maxBytes?: number
}

/** Sentinel -> Broker: artifact bytes (base64) or a structured error. */
export interface FetchArtifactResult {
  type: 'fetch_artifact_result'
  requestId: string
  ok: boolean
  /** base64-encoded file bytes (present when ok). */
  data?: string
  /** Detected media type, e.g. `text/html`. */
  mediaType?: string
  /** Byte length on disk. */
  size?: number
  error?: string
}

export interface ProjectTaskInputWire {
  title?: string
  body: string
  priority?: 'low' | 'medium' | 'high'
  tags?: string[]
  refs?: string[]
}

/** Broker -> Sentinel: a single project-board operation envelope. One message
 *  type for all board CRUD; `op` selects the action and which params apply. */
export interface ProjectBoardOp {
  type: 'project_board_op'
  requestId: string
  projectRoot: string
  op: 'list' | 'manifest' | 'get' | 'getBatch' | 'create' | 'update' | 'move' | 'delete'
  /** get / update / delete / move(from) */
  status?: ProjectTaskStatus
  /** get / update / delete / move */
  slug?: string
  /** list filter */
  filterStatus?: ProjectTaskStatus
  /** getBatch */
  refs?: ProjectTaskRef[]
  /** create */
  input?: ProjectTaskInputWire
  /** update */
  patch?: Partial<ProjectTaskInputWire>
  /** move */
  fromStatus?: ProjectTaskStatus
  toStatus?: ProjectTaskStatus
}

/** Sentinel -> Broker: board op result. Populated field depends on `op`. */
export interface ProjectBoardResult {
  type: 'project_board_result'
  requestId: string
  op: ProjectBoardOp['op']
  ok: boolean
  /** list */
  tasks?: ProjectTaskMeta[]
  /** manifest */
  manifest?: ProjectTaskManifestEntry[]
  /** getBatch */
  batch?: ProjectTaskMeta[]
  /** get / update */
  task?: ProjectTask | null
  /** create */
  note?: ProjectTaskMeta
  /** move (resulting slug) */
  slug?: string | null
  /** delete */
  removed?: boolean
  error?: string
}

/** Incremental project-board diff (was local to the agent-host watcher). */
export interface ProjectDiff {
  added: ProjectTaskManifestEntry[]
  removed: { slug: string; status: string }[]
  modified: ProjectTaskManifestEntry[]
}

/** Broker -> Sentinel: start OR renew a lease-bound board watch. Idempotent --
 *  re-sending re-stamps the lease expiry. The broker renews while >=1 dashboard
 *  views the project; the lease is the failsafe if the broker dies. */
export interface ProjectWatch {
  type: 'project_watch'
  /** Absolute project root on the sentinel's filesystem (for the chokidar watch). */
  projectRoot: string
  /** Canonical project URI -- echoed back in `project_changed` so the broker can
   *  broadcast-scope by project without re-deriving it from the host path. */
  project: string
  /** Lease duration in ms; sentinel self-stops if not renewed before expiry. */
  leaseMs: number
}

/** Broker -> Sentinel: stop watching immediately (last viewer closed). */
export interface ProjectUnwatch {
  type: 'project_unwatch'
  projectRoot: string
}

/** Sentinel -> Broker: project board changed. Tagged with the project URI (NO
 *  conversationId) -- the broker broadcasts permission-gated by `project`. */
export interface ProjectChanged {
  type: 'project_changed'
  project: string
  diff: ProjectDiff
  /** Full snapshot (transitional -- diff is the canonical signal). */
  notes: ProjectTaskMeta[]
}

// ---------------------------------------------------------------------------
// Dashboard -> Broker project requests. The dashboard never sends a host path;
// it sends the project URI and the broker resolves it to `projectRoot` + the
// owning sentinel before forwarding the sentinel-side RPC above.
// ---------------------------------------------------------------------------

/** Dashboard -> Broker: a project-board op (broker forwards as project_board_op). */
export interface ProjectBoardRequest {
  type: 'project_board_request'
  requestId: string
  /** Canonical project URI. */
  project: string
  op: ProjectBoardOp['op']
  status?: ProjectTaskStatus
  slug?: string
  filterStatus?: ProjectTaskStatus
  refs?: ProjectTaskRef[]
  input?: ProjectTaskInputWire
  patch?: Partial<ProjectTaskInputWire>
  fromStatus?: ProjectTaskStatus
  toStatus?: ProjectTaskStatus
}

/** Dashboard -> Broker: read a project-relative file (markdown viewer). */
export interface ProjectFileRequest {
  type: 'project_file_request'
  requestId: string
  project: string
  relPath: string
  maxBytes?: number
}

/** Dashboard -> Broker: this socket is now viewing a project board. The broker
 *  arms a lease-bound sentinel watch while >=1 dashboard is subscribed. */
export interface ProjectSubscribe {
  type: 'project_subscribe'
  project: string
}

/** Dashboard -> Broker: this socket stopped viewing a project board. */
export interface ProjectUnsubscribe {
  type: 'project_unsubscribe'
  project: string
}

// ===========================================================================
// NIGHTSHIFT RPCs (Dashboard / night-manager <-> Broker <-> Sentinel)
//
// The `.nightshift/` artifact tree (plan-nightshift.md §3) is written + read by
// the SENTINEL -- the same lease-watcher host that owns `.rclaude/project/` --
// so the morning Result screen works with ZERO live agent hosts. One op-envelope
// per direction, mirroring the ProjectBoardOp/Result idiom: the dashboard sends
// a project URI + op, the broker resolves it to an absolute `projectRoot` + the
// owning sentinel, forwards `nightshift_op`, and relays `nightshift_result` back.
//
// THE ARTIFACT IS THE API: writers (run_start / report / run_finalize) and
// readers (snapshot / config) all route here. The safe-to-do gate (Jonas
// directive #2) rides the `report` op with kind=skipped + a feasibility reason.
// ===========================================================================

/** The op selector shared by the dashboard request, the sentinel op, and the result. */
export type NightshiftOpKind =
  | 'snapshot' // read a run snapshot (runId omitted = latest) -- the Result screen
  | 'config_read'
  | 'config_write'
  | 'run_start' // create run dir + run.md (status=running) + repoint `latest`
  | 'report' // write one task / blocked / skipped artifact
  | 'task_patch' // ACT-ON-RESULTS: patch an existing task's frontmatter in place (plan §4)
  | 'run_finalize' // recompute totals, flip run.md to done, stamp digest/cost

/** Dashboard / night-manager -> Broker: one nightshift artifact op. */
export interface NightshiftRequest {
  type: 'nightshift_request'
  requestId: string
  /** Canonical project URI; the broker resolves it to projectRoot + sentinel. */
  project: string
  op: NightshiftOpKind
  /** snapshot (specific run; omit = latest) / run_start / report / run_finalize. */
  runId?: string
  /** config_write payload. */
  config?: NightshiftConfig
  /** run_start payload. */
  runStart?: NightshiftRunStartInput
  /** report payload (task | blocked | skipped). */
  report?: NightshiftReportInput
  /** task_patch payload (ACT-ON-RESULTS in-place frontmatter patch). */
  taskPatch?: NightshiftTaskPatchInput
  /** run_finalize payload. */
  finalize?: NightshiftFinalizeInput
}

/** Broker -> Sentinel: the same op, with the resolved absolute projectRoot. */
export interface NightshiftOp {
  type: 'nightshift_op'
  requestId: string
  projectRoot: string
  op: NightshiftOpKind
  runId?: string
  config?: NightshiftConfig
  runStart?: NightshiftRunStartInput
  report?: NightshiftReportInput
  taskPatch?: NightshiftTaskPatchInput
  finalize?: NightshiftFinalizeInput
}

/** Sentinel -> Broker: result of one op. Populated field depends on `op`. */
export interface NightshiftResult {
  type: 'nightshift_result'
  requestId: string
  op: NightshiftOpKind
  ok: boolean
  /** snapshot -- null when the project has no runs yet. */
  snapshot?: NightshiftRunSnapshot | null
  /** config_read / config_write -- the effective config. */
  config?: NightshiftConfig
  /** run_start / run_finalize -- the run after the write. */
  run?: NightshiftRun
  /** report(kind=task) -- the persisted task meta. */
  task?: NightshiftTaskMeta
  /** report(kind=blocked) -- the persisted blocked entry. */
  blocked?: NightshiftBlocked
  /** report(kind=skipped) -- the persisted skipped entry. */
  skipped?: NightshiftSkipped
  error?: string
}

/**
 * Broker -> Dashboard broadcast (permission-scoped by project URI): a nightshift
 * lifecycle beat, fired after the matching write op persists. The §6 event
 * vocabulary collapsed into one envelope -- the Result screen re-fetches the
 * snapshot on receipt rather than reconstructing state from the beat. The live
 * Status screen (P3) will read the richer fields directly.
 */
export interface NightshiftEvent {
  type: 'nightshift_event'
  /** Canonical project URI -- the broadcast scope key. */
  project: string
  event: 'run_started' | 'task_update' | 'task_done' | 'blocked' | 'impulse' | 'run_done'
  runId: string
  taskId?: string
  status?: string
  verdict?: string
  digest?: string
}

// ===========================================================================
// NIGHTSHIFT WATCHDOG -- the deterministic control tier (plan-nightshift.md §2.4)
//
// A broker reaper-style loop (~1 min, NO LLM) that enforces PURE THRESHOLDS on
// every live night-run task: per-task wall-clock / token / idle / turn caps,
// 429-detection, and capacity floors (read from smart-balance telemetry, NEVER
// re-derived). Honouring the LOG-EVERYTHING covenant, EVERY consideration is
// recorded -- not just the kills -- so the Status screen's decision log shows
// the watchdog's full reasoning, timestamped. The IMPULSE (LLM) tier is P5 and
// is deliberately NOT built here.
// ===========================================================================

/** Which cap/condition the watchdog evaluated. `capacity-floor` = the task's
 *  profile crossed the smart-balance interactive gate, so the night task yields. */
export type WatchdogCapKind = 'time' | 'tokens' | 'idle' | 'turns' | 'rate-limit' | 'capacity-floor'

/**
 * The watchdog's call for one task this tick:
 * - `observe` -- within every cap (logged anyway: LOG-EVERYTHING).
 * - `warn`    -- approaching a cap (>= warn fraction); no action, surfaced.
 * - `end`     -- a hard cap breached; the task is terminated with a terminal recap.
 * - `block`   -- transient/capacity reason (429 or floor); parked to the Blocked lane
 *                to resume another night rather than burning capacity now.
 */
export type WatchdogVerdict = 'observe' | 'warn' | 'end' | 'block'

/**
 * One timestamped watchdog consideration. Flat + JSON-safe (rides the WS, sits
 * in a broker-local ring). The metric snapshot is whatever the watchdog measured
 * at decision time; `kind` is the dominant cap when the verdict is warn/end/block
 * (absent for a clean `observe`).
 */
export interface WatchdogDecision {
  /** Unique id for this record (dedup + React keys). */
  id: string
  /** Decision timestamp, epoch ms. */
  at: number
  /** Canonical project URI -- the broadcast scope + Status-screen filter key. */
  project: string
  runId: string
  taskId: string
  conversationId: string
  /** resolvedProfile the task ran under (capacity truth, not URI userinfo). */
  profile?: string
  verdict: WatchdogVerdict
  /** Dominant cap for a warn/end/block (absent on a clean observe). */
  kind?: WatchdogCapKind
  /** Human-readable one-liner -- the "why", logged + shown verbatim. */
  reason: string
  // ─ metric snapshot at decision time (present when measured) ─
  elapsedMin?: number
  idleMin?: number
  tokens?: number
  turns?: number
  /** Profile 5h utilisation % read from smart-balance (capacity-floor checks). */
  fiveHourPct?: number
  /** The caps in force when this decision was made (for the log's context). */
  caps?: { perTaskMinutes?: number; idleMinutes?: number; perTaskTokens?: number; maxTurns?: number }
}

/** Control panel -> Broker: backfill the watchdog decision log for a project
 *  (the Status screen on mount). The live feed arrives via nightshift_watchdog_event. */
export interface NightshiftWatchdogRequest {
  type: 'nightshift_watchdog_request'
  requestId: string
  /** Canonical project URI -- scope + permission key (files:read). */
  project: string
  /** Optional: restrict to one run (omit = all runs in the ring for the project). */
  runId?: string
  /** Cap the number of (newest) decisions returned. */
  limit?: number
}

/** Broker -> Control panel: the requested slice of the decision-log ring. */
export interface NightshiftWatchdogResult {
  type: 'nightshift_watchdog_result'
  requestId: string
  ok: boolean
  decisions?: WatchdogDecision[]
  error?: string
}

/** Broker -> Control panel broadcast (project-scoped): one fresh watchdog
 *  decision, fired the moment the watchdog records it. */
export interface NightshiftWatchdogEvent {
  type: 'nightshift_watchdog_event'
  /** Canonical project URI -- the broadcast scope key. */
  project: string
  decision: WatchdogDecision
}

// ─── Project Checklists ─────────────────────────────────────────────────
// Per-project personal checklist ("notes from me to me") shown in the
// conversation list above a project's conversations. Broker-local data
// (checklists.db); the control panel drives every mutation over WS. Open items
// (`resolvedAt === null`) show inline; resolved items live in the archive view.
// `text` is stored raw; the panel renders a limited inline-markdown subset.

/** Lifecycle of a checklist item. `open` and `in_progress` show inline (active);
 *  `done` moves to the archive. in_progress is purely a user-facing emphasis. */
export type ChecklistStatus = 'open' | 'in_progress' | 'done'

export interface ChecklistItem {
  id: string
  text: string
  status: ChecklistStatus
  createdAt: number
  updatedAt: number
  /** null unless status === 'done'; epoch ms when checked off. */
  resolvedAt: number | null
}

/** Dashboard -> Broker: seed the inline block with current open items. */
export interface ChecklistListRequest {
  type: 'checklist_list'
  project: string
  requestId: string
}

/** Dashboard -> Broker: create N items (single add or multi-line paste). A
 *  `done` item is stamped resolved_at=now and lands straight in the archive. */
export interface ChecklistCreateRequest {
  type: 'checklist_create'
  project: string
  requestId: string
  items: Array<{ text: string; status?: ChecklistStatus }>
}

/** Dashboard -> Broker: move an item to a new lifecycle status. */
export interface ChecklistSetStatusRequest {
  type: 'checklist_set_status'
  project: string
  requestId: string
  id: string
  status: ChecklistStatus
}

/** Dashboard -> Broker: replace the WHOLE project list from the bulk markdown
 *  editor. The client encodes dates as trailing parens in the doc and parses
 *  them back, so it sends them here; the broker wipes the project's rows and
 *  re-inserts these. Missing dates are best-effort stamped now (metadata is a
 *  nice-to-have, per the user). */
export interface ChecklistReplaceRequest {
  type: 'checklist_replace'
  project: string
  requestId: string
  items: Array<{ text: string; status: ChecklistStatus; createdAt?: number; resolvedAt?: number }>
}

/** Dashboard -> Broker: edit an item's raw text. */
export interface ChecklistUpdateRequest {
  type: 'checklist_update'
  project: string
  requestId: string
  id: string
  text: string
}

/** Dashboard -> Broker: delete one item outright. */
export interface ChecklistDeleteRequest {
  type: 'checklist_delete'
  project: string
  requestId: string
  id: string
}

/** Dashboard -> Broker: list resolved items for the completed/archive view. */
export interface ChecklistArchiveRequest {
  type: 'checklist_archive'
  project: string
  requestId: string
}

/** Dashboard -> Broker: bulk-delete resolved items older than `olderThanMs`. */
export interface ChecklistPurgeRequest {
  type: 'checklist_purge'
  project: string
  requestId: string
  olderThanMs: number
}

/** Broker -> Dashboards (scoped by project): the fresh open list after any change. */
export interface ChecklistChanged {
  type: 'checklist_changed'
  project: string
  open: ChecklistItem[]
}

/** Agent or agent host reports a spawn failure (headless child exit, PTY crash, or early exit) */
export interface SpawnFailed {
  type: 'spawn_failed'
  conversationId: string
  project?: string
  pid?: number
  exitCode?: number | null
  error?: string
  elapsedMs?: number // time from spawn to exit (< 5000 = likely hook/config failure)
  /** Pre-flight warnings recorded before the spawn. When CC dies early, these
   *  are surfaced as likely-cause hints (e.g. "transcript file missing at the
   *  expected slug -- cwd may have changed since the original spawn"). */
  preflightHints?: string[]
  /** Last N lines of the agent host's stderr ring buffer (~30 lines). For
   *  headless spawns, also includes the tail of CC's own
   *  `.rclaude/settings/headless-{conversationId}.ndjsonl` log -- this is
   *  where hook failures land (e.g. `Error creating worktree: WorktreeCreate
   *  hook failed: fatal: a branch named '...' already exists`). Without this
   *  the user gets a generic "exit 1 in 1s" and has to dig through the
   *  ndjsonl file by hand. */
  stderrTail?: string[]
  /** Best-effort classification parsed from `stderrTail`. Examples:
   *  "WorktreeCreate" / "SessionStart" / "PreToolUse" -- the CC hook stage
   *  that crashed; "claude-launch" -- CC itself died before any hook ran;
   *  undefined -- no recognizable signal in the tail. */
  hookStage?: string
}

// Usage API data (agent polls api.anthropic.com/api/oauth/usage)
export interface UsageWindow {
  usedPercent: number // 0-100
  resetAt: string // ISO timestamp
}

export interface ExtraUsage {
  isEnabled: boolean
  monthlyLimit: number
  usedCredits: number
  utilization: number | null
}

export interface UsageUpdate {
  type: 'usage_update'
  fiveHour: UsageWindow
  sevenDay: UsageWindow
  sevenDayOpus?: UsageWindow
  sevenDaySonnet?: UsageWindow
  extraUsage?: ExtraUsage
  polledAt: number // timestamp of last poll
}

/**
 * Per-profile rollup of the OAuth usage endpoint. One snapshot per profile
 * known to the sentinel -- authed or not -- so the broker can render
 * "no telemetry" states without inventing data.
 *
 * See `.claude/docs/plan-sentinel-profile-usage.md`.
 */
export interface ProfileUsageSnapshot {
  /** Profile name (e.g. "default", "work"). Matches SentinelProfileInfo.name. */
  profile: string
  /** OAuth token discoverable in the profile's credential store. False -> no
   *  usage fields present; the row exists so the UI can show "not authed". */
  authed: boolean
  /** ms epoch of the most recent poll attempt (success or failure). */
  polledAt: number
  /** Usage windows -- present iff authed && fetch succeeded. */
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
  sevenDayOpus?: UsageWindow
  sevenDaySonnet?: UsageWindow
  extraUsage?: ExtraUsage
  /** Populated when authed but the fetch / parse failed. Mutually exclusive
   *  with the usage-window fields above. */
  error?: {
    kind: 'http' | 'parse' | 'network' | 'no_token'
    detail?: string
    status?: number
    /** Set on an HTTP 429: ms until the rate-limit window clears, parsed from
     *  the `retry-after` response header. The sentinel uses this to back off
     *  polling so it does not keep refreshing the throttle bucket. */
    retryAfterMs?: number
  }
  /** True when the usage windows above are a CARRIED-FORWARD last-good reading,
   *  re-emitted because the live poll is currently throttled (HTTP 429) or
   *  otherwise failing. The windows are real but as of `polledAt`, which will be
   *  older than the report's cycle time -- the control panel renders the age as
   *  a "usage Nm old" warning instead of pretending the data is fresh (or
   *  blanking the profile out). Absent/false on a fresh successful poll. */
  stale?: boolean
}

/**
 * Batched usage report sent by the sentinel once per poll cycle, covering
 * every profile in its config. The sentinelId is NOT on the wire -- the
 * broker stamps it from the authenticated connection.
 *
 * Replaces the per-default-profile-only `UsageUpdate` (which is kept emitting
 * for one release for back-compat with old brokers / panels).
 */
export interface SentinelUsageReport {
  type: 'sentinel_usage_report'
  profiles: ProfileUsageSnapshot[]
  polledAt: number // ms epoch of the polling cycle start
}

/** Classified reason a profile's auth is in trouble. Derived from the
 *  ProfileUsageSnapshot.error the sentinel already reports each poll cycle. */
export type AuthTroubleReason = 'http_401' | 'http_403' | 'no_token' | 'invalid_grant'

/**
 * Broker -> control-panel: a profile's OAuth auth has failed and needs a manual
 * re-login (`claude auth login` -- which CANNOT be automated; only the
 * inference-only `setup-token` is headless). Detected broker-side from the
 * per-profile error in `sentinel_usage_report`, debounced once-per-window per
 * `sentinelId:profile`, and broadcast as a first-class event that also drives a
 * push notification. Broadcast on the ControlPanelMessage channel.
 *
 * PROFILE-ENV BOUNDARY: the broker has no `configDir` (it is redacted from every
 * snapshot), so neither this message nor the push can carry the real profile
 * directory -- they name the profile and the generic recovery command only.
 */
export interface ProfileAuthTrouble {
  type: 'profile_auth_trouble'
  /** Sentinel that owns the profile -- stamped by the broker from the authed
   *  connection. Part of the debounce key (profiles aren't unique across hosts). */
  sentinelId: string
  /** Profile name, e.g. "work". */
  profile: string
  reason: AuthTroubleReason
  /** HTTP status when reason is http_401 / http_403. */
  status?: number
  /** Sanitized error snippet -- NEVER contains configDir (Profile-Env Boundary). */
  detail?: string
  /** ms epoch of the poll cycle that surfaced the failure. */
  polledAt: number
  /** Human recovery hint, e.g. "Run: CLAUDE_CONFIG_DIR=<your dir> claude auth login". */
  recoveryHint: string
}

// External status data (broker polls clanker.watch + usage.report)
export interface ClaudeHealthUpdate {
  type: 'claude_health_update'
  isUp: boolean
  status: 'operational' | 'investigating' | 'identified' | 'monitoring' | 'resolved' | 'unknown'
  uptime24h: number
  riskScore: number
  riskTrend: 'worsening' | 'improving' | 'stable'
  incidents7d: number
  lastIncidentTitle: string | null
  polledAt: number
}

export interface ClaudeEfficiencyUpdate {
  type: 'claude_efficiency_update'
  efficiency: number
  level: 'great' | 'good' | 'fair' | 'tight' | 'harsh' | 'brutal'
  currentDrainPp: number
  baselineDrainPp: number
  forecast: Array<{ hourUtc: number; efficiency: number; level: string }>
  polledAt: number
}

// --- Claude Code daemon (`claude agents`) read-only mirror -------------------
//
// Phase 1 of the daemon integration: the sentinel observes native background
// sessions hosted by `claude daemon` and pushes them to the broker, which
// surfaces them as read-only Conversation rows (agentHostType: 'daemon').
// See .claude/docs/plan-claude-agents-integration.md.

/**
 * A daemon background job as claudewerk sees it: the daemon's own JobRecord
 * (from the cc-daemon `list` op / roster.json) plus the stable conversationId
 * the sentinel minted for it. `sessionId` is the daemon's full session id --
 * a ccSessionId; the broker stores it opaquely and never routes by it.
 */
export interface DaemonJobInfo extends JobRecord {
  /** Stable claudewerk conversationId minted by the sentinel (conv_...). */
  conversationId: string
  /**
   * Sentinel-profile NAME this job was observed under -- the active profile of
   * the daemon socket the sentinel polled. Drives `Conversation.resolvedProfile`
   * on the broker mirror so the control panel can tint the badge correctly for
   * ghost (read-only daemon) conversations.
   *
   * `undefined` means the implicit default profile.
   *
   * PROFILE-ENV BOUNDARY: NAME only -- never configDir / env / API keys. The
   * sentinel keeps that data resident; the broker stores the name only.
   */
  profile?: string
}

/**
 * Sentinel -> Broker: the full set of daemon background jobs the sentinel
 * currently observes. Authoritative -- the broker reconciles its read-only
 * daemon Conversation rows against `jobs` (create new ones, mark vanished
 * ones ended). Sent on sentinel connect and on every roster.json change.
 */
export interface DaemonRosterUpdate {
  type: 'daemon_roster_update'
  /** Whether a `claude daemon` is currently reachable on the sentinel host. */
  daemonPresent: boolean
  /** Daemon control-protocol version (the cc-daemon `proto`), when known. */
  daemonProto?: number
  /** Every job the daemon currently knows about. Empty when daemonPresent is false. */
  jobs: DaemonJobInfo[]
  /** Epoch ms when the sentinel observed this roster. */
  observedAt: number
}

/**
 * Sentinel -> Broker: one daemon job's state changed -- a delta from a held
 * `subscribe` stream or a roster diff. Updates a single read-only daemon
 * Conversation row without resending the whole roster.
 */
export interface DaemonJobState {
  type: 'daemon_job_state'
  /** The job's current state, including its conversationId. */
  job: DaemonJobInfo
  /** Epoch ms when the sentinel observed this state. */
  observedAt: number
}

/**
 * A daemon roster job as the CONTROL PANEL receives it: `DaemonJobInfo` with
 * `sessionId` stripped. `sessionId` is a ccSessionId (CC's concept); the broker
 * never forwards it to the control panel (boundary rule). The ATTACH spawn
 * routes by the stable `short`, never by `sessionId`, so nothing is lost.
 */
export type DaemonRosterJob = Omit<DaemonJobInfo, 'sessionId'>

/**
 * Broker -> control panel: the live daemon worker roster, forwarded from the
 * sentinel's `DaemonRosterUpdate` with every ccSessionId removed. Drives the
 * spawn dialog's ATTACH mode roster browser. Distinct `type` from the
 * sentinel-sourced `daemon_roster_update` so the two directions never collide
 * in a handler table.
 */
export interface DaemonRosterForward {
  type: 'daemon_roster'
  /** Sentinel that owns this roster -- the ATTACH spawn targets it. */
  sentinelId?: string
  /** Human-readable sentinel alias, for display + spawn routing. */
  sentinelAlias?: string
  /** Whether a `claude daemon` is currently reachable on the sentinel host. */
  daemonPresent: boolean
  /** Daemon control-protocol version (the cc-daemon `proto`), when known. */
  daemonProto?: number
  /** Every job the daemon currently knows about, ccSessionId stripped. */
  jobs: DaemonRosterJob[]
  /** Epoch ms when the sentinel observed this roster. */
  observedAt: number
}

/**
 * Control panel -> broker: request a replay of the cached daemon roster(s).
 * Sent when the spawn dialog opens its ATTACH panel so a freshly-loaded
 * dashboard does not wait for the next sentinel push. The broker answers with
 * one `daemon_roster` per cached sentinel roster (to the caller only).
 */
export interface DaemonRosterRequest {
  type: 'daemon_roster_request'
}

// ─── Daemon launch lifecycle + remote control (Phase D / Phase G) ──────────

/**
 * A daemon-specific launch step surfaced to the user in the launch timeline.
 * Finer-grained than `boot_event` -- covers the `claude --bg` dispatch and the
 * daemon control-socket `attach` handshake the daemon-agent-host drives.
 */
export type DaemonLaunchStep =
  | 'dispatch_requested' // sentinel about to run claude --bg (new/resume)
  | 'worker_dispatched' // claude --bg returned a short id
  | 'attach_started' // daemon-host opening the attach socket
  | 'attach_retry' // ESTARTING/ENOJOB, retrying
  | 'attached' // attach ack received
  | 'attach_lost' // attach socket dropped, reconnecting
  | 'reattached' // re-attach succeeded
  | 'worker_gone' // worker left the roster / ended

/**
 * Agent host -> broker -> control panel: a structured daemon launch step,
 * rendered inline in the launch timeline. Every dispatch / attach / retry /
 * re-attach / worker-gone transition is one of these (EVERYTHING IS A
 * STRUCTURED MESSAGE). `raw` carries the full payload for the JsonInspector.
 */
export interface DaemonLaunchEvent {
  type: 'daemon_launch_event'
  conversationId: string
  step: DaemonLaunchStep
  daemonMode: 'new' | 'resume' | 'attach'
  /** 8-hex worker short, once known. */
  short?: string
  detail?: string
  /** Full structured payload for the JsonInspector (i) button. */
  raw?: Record<string, unknown>
  /** Epoch ms the step occurred. */
  t: number
}

/**
 * The outcome of a daemon remote-control op (reply / permission-response /
 * kill / respawn-stale). Phase G surfaces every control verb's result as one
 * of these.
 *
 * Emitted by the daemon-agent-host (the authority that runs the daemon op)
 * as an agent-host -> broker message; the broker re-broadcasts it scoped to
 * the conversation's project so the control panel renders the outcome
 * (EVERYTHING IS A STRUCTURED MESSAGE). The broker also originates one
 * directly on the failure path where it cannot even forward the request
 * (no daemon-agent-host socket).
 */
export interface DaemonControlResult {
  type: 'daemon_control_result'
  conversationId: string
  // Phase 7 adds set_model / set_effort / interrupt (the unified-control verbs the
  // daemon-agent-host now routes). set_model is live (reply /model -- spike 3b);
  // set_effort is recorded-for-respawn (live /effort is a no-op -- spike 3a);
  // interrupt writes Ctrl+C to the worker PTY.
  // `permission_response` removed 2026-05-27 (sweep P1-2 / P3-5) -- the daemon
  // permission-response op is a stub; the verified path is PermissionResponse
  // + daemonControl.reply() (see src/daemon-agent-host/index.ts handleInbound).
  op: 'reply' | 'kill' | 'respawn_stale' | 'set_model' | 'set_effort' | 'interrupt'
  ok: boolean
  /** Daemon error code on failure (EPROTO, ENOJOB, ENOREPLY, ...). */
  code?: string
  detail?: string
  /** Epoch ms the op settled. */
  t: number
}

/**
 * Universal control-debug envelope (plan-cc-control-debug.md). One generic
 * message family instead of a wire type per control subtype. The `traceId`
 * correlates the whole WEB -> BROKER -> AGENT HOST -> CC/daemon round-trip.
 * Command + payload are validated against the shared registry in
 * `cc-control-commands.ts`. The broker permission-gates + audits every send;
 * the agent host dispatches to the stream-json control channel (cc_control) or
 * the daemon socket (daemon_op) per the target conversation's transport.
 *
 * WEB -> BROKER -> AGENT HOST.
 */
export interface DebugControlSend {
  type: 'debug_control_send'
  traceId: string
  targetConversation: string
  channel: 'cc_control' | 'daemon_op'
  command: string
  payload: Record<string, unknown>
}

/**
 * One breadcrumb per seam of a debug-control round-trip. Emitted by the agent
 * host (agenthost_* seams) and the broker (broker_* seams), broadcast to the
 * control panel which renders the waterfall. Persisted to the conversation's
 * debug ring for post-hoc inspection (LOG-EVERYTHING covenant).
 *
 * AGENT HOST -> BROKER (host seams) and BROKER -> control panel (relay).
 */
export interface DebugTraceEvent {
  type: 'debug_trace_event'
  traceId: string
  conversationId: string
  seam:
    | 'web_send'
    | 'broker_recv'
    | 'broker_forward'
    | 'agenthost_recv'
    | 'agenthost_to_cc'
    | 'cc_to_agenthost'
    | 'agenthost_to_broker'
    | 'broker_to_web'
    | 'error'
  ok?: boolean
  detail?: string
  /** Full payload for the (i) JsonInspector expansion. */
  raw?: Record<string, unknown>
  /** Epoch ms. */
  t: number
}

/**
 * The terminal response of a debug-control round-trip: CC's control_response
 * payload, or the daemon op response, or an error. AGENT HOST -> BROKER ->
 * control panel.
 */
export interface DebugControlResult {
  type: 'debug_control_result'
  traceId: string
  conversationId: string
  channel: 'cc_control' | 'daemon_op'
  command: string
  ok: boolean
  /** CC control_response payload / daemon op response (shape varies by command). */
  response?: unknown
  error?: string
  /** Daemon error code, or 'unsupported_transport' / 'unknown_command' / 'no_agent_host'. */
  code?: string
  elapsedMs: number
  t: number
}

/**
 * Agent host -> broker -> control panel: a daemon worker's effort level was set
 * (transport-reframe Phase 7, feature #1). Phase 7 spike 3a established that
 * `/effort` via the daemon `reply` op is a NO-OP -- `CLAUDE_CODE_EFFORT_LEVEL`
 * is a process-env var the worker reads at startup, so a live effort change is
 * not possible. This message RECORDS the requested level; `appliedVia` says how
 * it takes effect: `next_dispatch` (recorded -- applies when the worker next
 * (re)spawns with the env var). The control panel surfaces the queued change.
 */
export interface EffortChanged {
  type: 'effort_changed'
  conversationId: string
  /** Requested effort: low | medium | high | xhigh | max | auto. */
  level: string
  appliedVia: 'next_dispatch'
  t: number
}

/**
 * Agent host -> broker -> control panel: ONE cc-daemon `subscribe` state patch,
 * the typed shape derived from the Phase 7 live captures (2026-05-23). The patch
 * is a partial `JobRecord` -- only changed fields ship. Live-confirmed keys:
 * `state`, `tempo`, `detail`, `needs` (+ `pid`, ignored here). The daemon-agent-
 * host status mirror forwards these so the control panel shows the worker's own
 * status vocab instead of scraping the PTY. `raw` carries the full patch for the
 * JsonInspector.
 */
export interface DaemonStatePatch {
  type: 'daemon_state_patch'
  conversationId: string
  state?: DaemonRunState
  tempo?: 'active' | 'idle'
  detail?: string
  /** Human-readable "what's blocking", when the worker is at a gate (often ""). */
  needs?: string
  /** Full raw patch for the JsonInspector (i) button. */
  raw?: Record<string, unknown>
  /** Epoch ms the patch was observed. */
  t: number
}

/**
 * Agent host -> broker -> control panel: a daemon worker surfaced an interaction
 * gate (tool-use permission or AskUserQuestion) on its `subscribe` state stream.
 *
 * DEFENSIVE / DORMANT: Phase 7 live spikes (3d/3e, 2026-05-23) established that
 * claudewerk's `source:'fleet'` spare-pool workers AUTO-ACCEPT tool permissions
 * -- no block fired across the captures, so this message is not emitted in the
 * common config. It exists so that IF a worker ever reports `state:'blocked'` or
 * a `block`/`needs` patch, the control panel surfaces it (and the `requestId`,
 * when present, is the `permission-response` correlator). Built on the protocol-
 * doc-predicted `block:{requestId}` shape (§ 5.5) since it could not be captured
 * live. See feature #5 / #10 (documented regressions).
 */
export interface DaemonBlockObserved {
  type: 'daemon_block_observed'
  conversationId: string
  /** The human-readable "what's blocking" string (the daemon `needs` field). */
  needs?: string
  /** The `permission-response` correlator, if the daemon surfaced one in `block`. */
  requestId?: string
  /** Full raw block payload for the JsonInspector. */
  raw?: Record<string, unknown>
  /** Epoch ms the block was observed. */
  t: number
}

/**
 * Control panel -> broker: respawn a sleep/wake-stale daemon worker via the
 * daemon `respawn-stale` op. Phase G -- the handler lands with the remote
 * control work; the type is defined here so the wire contract is stable.
 */
export interface DaemonRespawnStaleRequest {
  type: 'daemon_respawn_stale'
  conversationId: string
}

/**
 * Agent host -> broker: a daemon worker that was last seen idle vanished from
 * the daemon roster after the long-idle retirement threshold, so the host
 * reclassifies the vanish as a session retirement instead of a generic
 * disconnect. Fired BEFORE the agent host's `shutdown('daemon-job-gone')`
 * so the broker has a typed reason for the conversation end.
 *
 * BOUNDARY note: `ccSessionId` here is the agent host's last known id for
 * the worker. The broker stores it in the opaque `agentHostMeta` bag; it is
 * NEVER read back as a typed field. The broker key is `conversationId`.
 */
export interface DaemonSessionRetired {
  type: 'daemon_session_retired'
  conversationId: string
  /** 8-hex daemon worker short id. Stable for the lifetime of the worker. */
  short: string
  /** Last `ccSessionId` the host observed for this worker, if any. Opaque to broker. */
  ccSessionId: string | null
  /** Daemon-side `JobRecord.state` value at the last successful observation.
   *  `'idle'` is the retirement marker; other strings preserved for forensics. */
  lastState: 'idle' | 'busy' | 'done' | 'failed' | string
  /** Milliseconds the worker had been idle when it vanished. */
  idleMs: number
  /** Epoch ms the retirement was observed. */
  retiredAt: number
}

// DaemonPermissionResponse was removed 2026-05-27 (sweep finding P1-2). The
// daemon's `permission-response` op is DEAD -- confirmed against 2.1.168: the
// required `requestId` correlator is never surfaced in the JobRecord, so the
// op can never be satisfied. Daemon (fleet) workers do not raise CC's numbered
// tool-permission menu either; they surface gates as conversational
// `state:blocked` questions (the `needs` text) answered by a FREE-TEXT reply
// via the chat box (the generic `input` wire -> daemon `reply`). The generic
// `permission_response` wire (PermissionResponse) is the live path for
// headless/PTY only and is NOT applicable to daemon workers (see
// docs/daemon-mode.md + the daemon-agent-host handleInbound no-op).

/**
 * Sentinel -> Broker: the Claude Code daemon version or control-protocol
 * number observed on this sentinel changed. Fired on the very first successful
 * ping after install (with `fromVersion: null` / `fromProto: null`) and on
 * every subsequent diff. Drives the control-panel banner asking the user to
 * drain in-flight workers.
 *
 * BOUNDARY-clean: scoped to a sentinel, not a conversation. The broker never
 * routes by ccSessionId here -- this is sentinel-host metadata, not a per-
 * conversation identity.
 */
export interface CcVersionChanged {
  type: 'cc_version_changed'
  sentinelId: string
  /** Previous version. `null` on the first observation after install. */
  fromVersion: string | null
  toVersion: string
  /** Previous control-protocol number. `null` on the first observation. */
  fromProto: number | null
  toProto: number
  /** Epoch ms the sentinel observed the diff. */
  observedAt: number
}

/**
 * Sentinel -> Broker: the installed Claude Code version is below the minimum
 * required for the requested `defaultTransport`. Emitted on every poll while
 * the condition holds so a freshly-loaded dashboard surfaces the gap; the
 * sentinel suppresses identical re-emits within the same poll window so it is
 * idempotent (one fire per (sentinelId, requiredVersion, installedVersion)).
 *
 * Drives the safety-net banner: prod cannot silently default to the daemon
 * backend when the local `claude` binary is too old (sleep/wake stale
 * recovery + dispatch socket op land in 2.1.142). Sweep P1-3, second wire msg.
 *
 * BOUNDARY-clean: scoped to a sentinel, no ccSessionId touched.
 */
export interface CcMinVersionUnmet {
  type: 'cc_min_version_unmet'
  sentinelId: string
  /** Installed CC version as reported by the daemon ping. */
  installedVersion: string
  /** Minimum CC version required by the active configuration. */
  requiredVersion: string
  /** What this minimum protects -- for the banner copy. */
  requiredFor: 'daemon-backend' | string
  /** Epoch ms the sentinel observed the gap. */
  observedAt: number
}

export type SentinelMessage =
  | SentinelIdentify
  | ReviveResult
  | SpawnResult
  | SpawnFailed
  | ListDirsResult
  | ListCcSessionsResult
  | GitLogResult
  | ProjectReadFileResult
  | ProjectWriteFileResult
  | ProjectMoveFileResult
  | FetchArtifactResult
  | ProjectBoardResult
  | ProjectChanged
  | NightshiftResult
  | UsageUpdate
  | SentinelUsageReport
  | LaunchLog
  | DaemonRosterUpdate
  | DaemonJobState
  | CcVersionChanged
  | CcMinVersionUnmet
  | SentinelPatchConfigAck
  | ShellExit
  | ShellActivity
  | ShellData
  | ShellReplay
  | ShellResync
  | ShellOriginated

// Broker -> Sentinel messages
//
// These carry the full conversation snapshot the sentinel needs to boot a CC
// session. The conversation is the addressable entity; ccSessionId is metadata
// the agent host attaches on connect.

export interface ReviveConversation {
  type: 'revive'
  conversationId: string
  project: string
  ccSessionId: string // CC session ID to resume (--resume)
  jobId?: string
  // Conversation metadata
  conversationName?: string
  // Launch config
  mode?: 'fresh' | 'resume'
  headless?: boolean
  effort?: string
  model?: string
  agent?: string
  advisor?: string
  bare?: boolean
  repl?: boolean
  permissionMode?: string
  // Limits
  autocompactPct?: number
  maxBudgetUsd?: number
  // Context
  adHocWorktree?: string
  env?: Record<string, string>
  /** Which agent host binary to use. Defaults to 'claude' (rclaude).
   *  Mirrors SpawnConversation.agentHostType for revive-time dispatch. */
  agentHostType?: string
  /** OpenCode-specific model identifier. Passed to opencode-host via OPENCODE_MODEL
   *  or to acp-host via ACP_AGENT_INITIAL_MODEL. */
  openCodeModel?: string
  /** Which ACP agent recipe to use when agentHostType === 'acp'. */
  acpAgent?: string
  /** Tool permission tier: 'none' | 'safe' | 'full'. */
  toolPermission?: 'none' | 'safe' | 'full'
  /** Sentinel-profile pin for revive -- always a literal profile NAME (the
   *  broker reads it back from the stored `projectUri` userinfo). Revive
   *  never re-rolls balanced/random selection. `SelectionMode` is permitted
   *  in the type only to keep the wire shape symmetrical with
   *  `SpawnConversation.profile`; the broker should always send a name on
   *  revive. Profile env (configDir, API keys) is resolved sentinel-side. */
  profile?: SelectionMode | string
}

export interface SpawnConversation {
  type: 'spawn'
  requestId: string
  conversationId: string
  cwd: string
  project?: string
  jobId?: string
  // Conversation metadata
  conversationName?: string
  conversationDescription?: string
  // Launch config
  mkdir?: boolean
  mode?: 'fresh' | 'resume'
  resumeId?: string
  headless?: boolean
  effort?: string
  model?: string
  agent?: string
  advisor?: string
  bare?: boolean
  repl?: boolean
  permissionMode?: string
  // Limits
  autocompactPct?: number
  maxBudgetUsd?: number
  // Ad-hoc task runner fields
  prompt?: string
  adHoc?: boolean
  adHocTaskId?: string
  leaveRunning?: boolean
  includePartialMessages?: boolean
  worktree?: string
  env?: Record<string, string>
  /** Text appended to the generated system prompt. CC maps to --append-system-prompt;
   *  chat-api prepends as a system message. Ignored by backends that cannot honor
   *  it cleanly (hermes, opencode). */
  appendSystemPrompt?: string
  /** Backend-general absolute path to a settings JSON (transport-reframe § 2.1,
   *  promoted from the daemon-only `daemonSettingsPath`). Honored by claude
   *  across ALL transports: the daemon path passes `--settings`; the PTY/headless
   *  agent host MERGES it into its generated hooks settings file (CC `--settings`
   *  is single-value, so a second flag would clobber the hooks). */
  settingsPath?: string
  /** Backend-general absolute path to an MCP config JSON (transport-reframe § 2.1).
   *  Honored by claude across ALL transports: the daemon path passes `--mcp-config`;
   *  the PTY/headless agent host appends it as an additional `--mcp-config` value
   *  alongside the rclaude HTTP server (CC `--mcp-config` is variadic and merges). */
  mcpConfigPath?: string
  /** Which agent host binary to spawn. Defaults to 'claude' (rclaude). When
   *  set to 'opencode', the sentinel launches the opencode-host binary with
   *  OPENCODE_MODEL set. When set to 'acp', the sentinel launches the
   *  generic acp-host binary parameterized by `acpAgent` (see acp-recipes). */
  agentHostType?: string
  /** OpenCode-specific model identifier (e.g. 'openrouter/anthropic/claude-haiku-4.5').
   *  Used when agentHostType === 'opencode'; passed to opencode-host via OPENCODE_MODEL.
   *  When agentHostType === 'acp' we read this same field as the initial model
   *  to apply via session/set_config_option after session/new. */
  openCodeModel?: string
  /** OpenCode tool permission tier. 'none' = no tools, 'safe' = read-only,
   *  'full' = all tools (--dangerously-skip-permissions). Defaults to 'safe'
   *  at spawn time when not specified by request or project settings. Reused
   *  by the ACP path (drives the acp-host's session/request_permission policy). */
  toolPermission?: 'none' | 'safe' | 'full'
  /** Which ACP agent recipe to use when agentHostType === 'acp'. The sentinel
   *  resolves this against its acp-recipes registry. e.g. 'opencode'. */
  acpAgent?: string
  /** Resolved transport for this spawn (transport-reframe § 0.2): the wire
   *  mechanism driving the claude backend. The sentinel routes daemon spawns by
   *  agentHostType === 'daemon' and reads the daemon launch inputs (mode /
   *  attachShort / resumeSessionId / settingsPath / mcpConfigPath) from
   *  `transportMeta` -- there are no flat `daemon*` fields on this message. */
  transport?: string
  /** Backend-specific opaque bag (parallel to agentHostMeta). The broker core
   *  forwards it wholesale; only the backend / sentinel dispatch path / agent
   *  host read it. The claude-daemon transport's launch inputs ride here:
   *  `mode` ('new'|'resume'|'attach'), `attachShort`, `resumeSessionId`,
   *  `settingsPath`, `mcpConfigPath`, `appendSystemPrompt`. See
   *  `.claude/docs/plan-claude-transport-reframe.md` § 0.3. */
  transportMeta?: Record<string, unknown>
  /** Sentinel-profile selection at spawn time. Either a `SelectionMode`
   *  ('default' | 'balanced' | 'random') OR a literal profile NAME ("Fixed"
   *  mode). When absent the sentinel falls back to its `defaultSelection`.
   *  Profile env (configDir, API keys) is resolved sentinel-side from this
   *  name -- the broker never holds it (Profile-Env Boundary covenant). */
  profile?: SelectionMode | string
  /** Pool name for Balanced/Random selection (`[a-z0-9-]{1,63}`). When
   *  absent the sentinel substitutes its configured `defaultPool` (default
   *  `"default"`). Ignored for Fixed (a literal profile name beats it). */
  pool?: string
}

/**
 * Broker -> Sentinel: tune the BROKER-TUNABLE subset of a sentinel's config
 * live, without a restart. See `.claude/docs/plan-sentinel-profiles.md` Phase 8.
 *
 * PROFILE-ENV BOUNDARY: this message carries NAME / display / routing fields
 * ONLY. It deliberately has NO `configDir`, `env`, or `spawnRoot` field, and
 * no add/remove-profile capability -- those bind a profile NAME to a host
 * filesystem path / credentials and stay sentinel-local (CLI-only). The broker
 * forwards this verbatim; it never reads the field set because the secret-bearing
 * fields are not in the type. `lint:boundary` rejects any reference to
 * `env` / `configDir` from a `sentinel_patch_config` site.
 */
export interface SentinelPatchConfig {
  type: 'sentinel_patch_config'
  /** Correlation id so the broker can match the ack to the request. */
  patchId: string
  /** Per-profile patches keyed by EXISTING profile NAME. Each field is
   *  optional -- only the present fields are mutated; omitted fields are left
   *  untouched. `pool: null` excludes the profile from every pool (a real
   *  value, distinct from "omitted"). Unknown profile names are rejected by
   *  the sentinel (it never creates a profile from a patch). */
  profiles?: Record<
    string,
    {
      /** Relative selection weight, `>= 0`. `0` = soft drain. */
      weight?: number
      /** Named pool, or `null` to exclude from every pool. */
      pool?: string | null
      label?: string
      color?: string
    }
  >
  /** Sentinel-wide no-input selection mode. */
  defaultSelection?: SelectionMode
  /** Sentinel-wide fallback pool for Balanced/Random launches that omit a pool. */
  defaultPool?: string
}

/**
 * Sentinel -> Broker: result of applying a `sentinel_patch_config`.
 *
 * On success the sentinel mutated its in-memory config, atomically rewrote
 * `sentinel.json` (tmp + rename, unknown keys preserved), and returns a fresh
 * `applied` snapshot (the same broker-safe slice as `sentinel_identify`) so the
 * broker can refresh its stored profile registry without waiting for the next
 * identify. On failure the sentinel rolled back in-memory and `ok` is `false`
 * with a structured `error` code.
 */
export interface SentinelPatchConfigAck {
  type: 'sentinel_patch_config_ack'
  patchId: string
  ok: boolean
  /** Structured failure code. `unknown_profile` -- a patched name is not
   *  configured; `invalid_value` -- a field failed validation (bad weight /
   *  pool / selection); `io_error` -- the atomic file write failed (in-memory
   *  rolled back). */
  error?: 'unknown_profile' | 'invalid_value' | 'io_error'
  /** Human-readable detail accompanying `error` (which profile / field). */
  detail?: string
  /** Fresh post-apply snapshot. Present on success. The broker-safe slice --
   *  NAMES + display + routing only, NEVER configDir / env. */
  applied?: SentinelIdentify
}

export interface ListDirs {
  type: 'list_dirs'
  requestId: string
  path: string
}

export interface ListCcSessions {
  type: 'list_cc_sessions'
  requestId: string
  cwd: string
}

export interface RclaudeConfigGet {
  type: 'rclaude_config_get'
  requestId: string
  project: string
}

export interface RclaudeConfigSet {
  type: 'rclaude_config_set'
  requestId: string
  project: string
  config: RclaudePermissionConfig
}

export interface RclaudePermissionConfig {
  permissions?: {
    Write?: { allow?: string[] }
    Edit?: { allow?: string[] }
    Read?: { allow?: string[] }
  }
  allowAll?: boolean
  allowPlanMode?: boolean
}

export interface RclaudeConfigData {
  type: 'rclaude_config_data'
  requestId: string
  config: RclaudePermissionConfig | null
  path: string
  project: string
}

export interface RclaudeConfigOk {
  type: 'rclaude_config_ok'
  requestId: string
  ok: boolean
  error?: string
}

export interface SentinelQuit {
  type: 'quit'
  reason?: string
}

export interface SentinelReject {
  type: 'sentinel_reject'
  reason: string
}

export type BrokerSentinelMessage =
  | ReviveConversation
  | SpawnConversation
  | ListDirs
  | ListCcSessions
  | GitLogRequest
  | ProjectReadFile
  | ProjectWriteFile
  | ProjectMoveFile
  | FetchArtifact
  | ProjectBoardOp
  | ProjectWatch
  | ProjectUnwatch
  | NightshiftOp
  | SentinelPatchConfig
  | SentinelQuit
  | SentinelReject
  | ShellOpen
  | ShellClose
  | ShellInput
  | ShellResize
  | ShellAttach
  | ShellDetach

// Dashboard broadcast: sentinel status
export interface SentinelStatus {
  type: 'sentinel_status'
  connected: boolean
}

// Foreground-task fields shared by the broker wire type (ConversationSummary)
// and the web client model (Conversation). Those two interfaces are hand-mirrored
// across two separate TS builds with no shared runtime package, so the whole
// Conversation shape is duplicated on purpose. The task block is the one slice
// worth centralising: pulling it into a single referenced interface keeps both
// sides in lockstep AND stops it re-surfacing as a fallow cross-file duplication
// clone on every future edit to the region. `{ id: string; subject: string }` is
// the minimal task-ref the card carries (a narrower view than TaskInfo).
export interface ConversationTaskFields {
  taskCount: number
  pendingTaskCount: number
  activeTasks: Array<{ id: string; subject: string }>
  pendingTasks: Array<{ id: string; subject: string }>
  completedTaskCount: number
  completedTasks: Array<{ id: string; subject: string }>
  archivedTaskCount: number
  archivedTasks?: Array<{ id: string; subject: string }>
  taskSubjects?: Record<string, string>
}

// Conversation summary: broker -> dashboard wire format
export interface ConversationSummary extends ConversationTaskFields {
  id: string
  project: string
  /** Live working directory the agent is in now (worktree, sub-project, cd).
   *  `project` stays pinned to the launch URI; this shifts via `cwd_changed`. */
  currentPath?: string
  model?: string
  capabilities?: AgentHostCapability[]
  version?: string
  buildTime?: string
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
  connectionIds: string[]
  startedAt: number
  lastActivity: number
  status: Conversation['status']
  compacting?: boolean
  compactedAt?: number
  eventCount: number
  activeSubagentCount: number
  totalSubagentCount: number
  subagents: Array<{
    agentId: string
    agentType: string
    description?: string
    status: 'running' | 'stopped'
    startedAt: number
    stoppedAt?: number
    eventCount: number
    tokenUsage?: { totalInput: number; totalOutput: number; cacheCreation: number; cacheRead: number }
  }>
  // taskCount / pendingTaskCount / activeTasks / pendingTasks /
  // completedTaskCount / completedTasks / archivedTaskCount / archivedTasks /
  // taskSubjects come from ConversationTaskFields (shared with web Conversation).
  runningBgTaskCount: number
  bgTasks: Array<{
    taskId: string
    command: string
    description: string
    startedAt: number
    completedAt?: number
    status: 'running' | 'completed' | 'killed'
  }>
  monitors: MonitorInfo[]
  runningMonitorCount: number
  teammates: Array<{
    name: string
    status: TeammateInfo['status']
    currentTaskSubject?: string
    completedTaskCount: number
  }>
  team?: TeamInfo
  effortLevel?: string
  permissionMode?: string
  lastError?: Conversation['lastError']
  rateLimit?: Conversation['rateLimit']
  planMode?: boolean
  pendingAttention?: Conversation['pendingAttention']
  /** THE STATUS — agent self-reported task state; drives the attention badge. */
  liveStatus?: LiveStatus
  /** Last user-impulse time (UserPromptSubmit). Paired with liveStatus.updatedAt
   *  so the UI can mark a status SUPERSEDED by a later user message. */
  lastInputAt?: number
  /** Mirror of caller.pendingSpawnApproval -- drives the in-panel approval banner. */
  pendingSpawnApproval?: Conversation['pendingSpawnApproval']
  /** Sticky bit: caller has been granted standing spawn approval. */
  spawnAutoApproved?: boolean
  hasNotification?: boolean
  summary?: string
  title?: string
  description?: string
  agentName?: string
  prLinks?: Conversation['prLinks']
  linkedProjects?: Array<{ project: string; name: string }>
  /** Conversation-scoped links (the `:` ad-hoc grant) -- narrower than linkedProjects. */
  linkedConversations?: Array<{ conversationId: string; name: string }>
  tokenUsage?: { input: number; cacheCreation: number; cacheRead: number; output: number }
  contextWindow?: number // effective window (200K or 1M) matching Claude Code's current selection
  cacheTtl?: '5m' | '1h'
  lastTurnEndedAt?: number
  stats: Conversation['stats']
  costTimeline?: Conversation['costTimeline']
  gitBranch?: string
  spinnerVerbs?: string[]
  autocompactPct?: number
  maxBudgetUsd?: number
  adHocTaskId?: string
  adHocWorktree?: string
  modelMismatch?: Conversation['modelMismatch']
  resultText?: string
  recap?: Conversation['recap']
  recapFresh?: boolean
  hostSentinelId?: string
  hostSentinelAlias?: string
  /** True iff this conversation's host sentinel advertises `features.shell`
   *  (joined from the sentinel registry via `hostSentinelId`). Gates the
   *  `Cmd+G S` "open shell" chord. The dock itself is driven by the global
   *  roster, not this flag. See plan-host-shell.md 3.1. */
  shellCapable?: boolean
  /** Resolved sentinel-profile name. Absent (or undefined) means the conversation
   *  ran on the implicit default profile. Mirrors `Conversation.resolvedProfile`. */
  resolvedProfile?: string
  /** Agent family (claude / opencode / chat-api / hermes). The daemon is NOT a
   *  backend -- a daemon conversation reports `backend: 'claude'` + the
   *  `claude-daemon` transport below. */
  backend?: string
  /** Resolved transport for the claude family: 'claude-pty' | 'claude-headless'
   *  | 'claude-daemon'. The canonical discriminator the control panel keys
   *  daemon-specific UI off. */
  transport?: string
  /** Direct spawner conversationId (mirrors `Conversation.parentConversationId`).
   *  See plan-spawn-parent-tracking.md. Stable for the lifetime of the conversation. */
  parentConversationId?: string
  /** Topmost ancestor in the spawn chain (mirrors `Conversation.rootConversationId`).
   *  Grouping key for the control panel project list. */
  rootConversationId?: string
  /** NIGHTSHIFT origin tag (mirrors `Conversation.launchConfig.nightshift`, but
   *  carries ONLY the run/task ids -- never the full launchConfig, which holds
   *  env + appendSystemPrompt). Present => an unattended night-run task; lets the
   *  live Status screen filter night rows without leaking launch internals. */
  nightshift?: { runId: string; taskId: string }
}

// Subscription channels (dashboard <-> broker pub/sub)
export type SubscriptionChannel =
  | 'conversation:events'
  | 'conversation:transcript'
  | 'conversation:tasks'
  | 'conversation:bg_output'
  | 'conversation:subagent_transcript'

// Control Panel -> Broker: channel subscription management
export interface ChannelSubscribe {
  type: 'channel_subscribe'
  channel: SubscriptionChannel
  conversationId: string
  agentId?: string // required for session:subagent_transcript
}

export interface ChannelUnsubscribe {
  type: 'channel_unsubscribe'
  channel: SubscriptionChannel
  conversationId: string
  agentId?: string
}

export interface ChannelUnsubscribeAll {
  type: 'channel_unsubscribe_all'
}

// Broker -> Control Panel: subscription acknowledgment
export interface ChannelAck {
  type: 'channel_ack'
  channel: SubscriptionChannel
  conversationId: string
  agentId?: string
  status: 'subscribed' | 'unsubscribed'
  previousConversationId?: string // set during rekey rollover (routing key, matches conversation.id)
}

// Per-channel diagnostic stats
export interface ChannelStats {
  channel: SubscriptionChannel
  conversationId: string
  agentId?: string
  subscribedAt: number
  messagesSent: number
  bytesSent: number
  lastMessageAt: number
}

// Per-subscriber diagnostic info
export interface SubscriberDiag {
  id: string
  userName?: string
  protocolVersion: number
  connectedAt: number
  channels: ChannelStats[]
  totals: {
    messagesSent: number
    bytesSent: number
    messagesReceived: number
    bytesReceived: number
  }
}

// GET /api/subscriptions response
export interface SubscriptionsDiag {
  subscribers: SubscriberDiag[]
  summary: {
    totalSubscribers: number
    legacySubscribers: number
    v2Subscribers: number
    channelCounts: Record<string, number>
    totalBytesSent: number
    totalMessagesSent: number
  }
}

// Live connection diagnostics (Nerd "Conns" tab + /api/connections)
export type ConnectionRole = 'web' | 'agent-host' | 'sentinel' | 'gateway' | 'share' | 'unknown'

export interface ConnectionInfo {
  connectionId: string
  role: ConnectionRole
  identity: string
  userName?: string
  conversationId?: string
  project?: string
  sentinelId?: string
  sentinelAlias?: string
  gatewayType?: string
  gatewayId?: string
  hostname?: string
  remoteAddr?: string
  userAgent?: string
  connectedAt: number
  channelCount: number
  channels?: Array<{ channel: string; conversationId: string }>
  bytesIn: number
  bytesOut: number
  msgsIn: number
  msgsOut: number
  protocolVersion?: number
}

// ----------------------------------------------------------------------------
// Period Recap (long-form markdown digest of a project over a period)
// ----------------------------------------------------------------------------

export type RecapPeriodLabel = 'today' | 'yesterday' | 'last_7' | 'last_30' | 'this_week' | 'this_month' | 'custom'

// 'partial'     -- completed, but at least one map chunk was dropped (timeout /
//                  truncation / deadline). The document rendered; it is just
//                  missing some input. Surfaced with a banner, NOT a silent 'done'.
// 'interrupted' -- an in-flight run was orphaned (broker restart killed the async).
//                  Resumable from its on-disk bundle; NEVER auto-resumed.
export type RecapStatus =
  | 'queued'
  | 'gathering'
  | 'rendering'
  | 'done'
  | 'partial'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
// Truly finished -- nothing left to run, no resume. (interrupted is NOT here: it
// is paused/resumable. Use isRecapResumable for that.)
export const RECAP_TERMINAL_STATUSES = ['done', 'partial', 'failed', 'cancelled'] as const
export function isRecapTerminal(status: RecapStatus): boolean {
  return (RECAP_TERMINAL_STATUSES as readonly string[]).includes(status)
}
/** A run currently executing (an async owns it). Boot-sweep targets these. */
export function isRecapInFlight(status: RecapStatus): boolean {
  return status === 'queued' || status === 'gathering' || status === 'rendering'
}
/** Has a resumable on-disk bundle and is not actively running. */
export function isRecapResumable(status: RecapStatus): boolean {
  return status === 'interrupted'
}
export type RecapLogLevel = 'info' | 'warn' | 'error' | 'debug'
export type RecapSignal =
  | 'user_prompts'
  | 'assistant_final_turn'
  | 'commits'
  | 'task_results'
  | 'tool_summaries'
  | 'errors_hooks'
  | 'cost'
  | 'open_questions'
  /** Deep turn content (intermediate assistant text + tool-call summaries),
   *  not just the final message. Opt-in -- expensive, NOT in DEFAULT_SIGNALS.
   *  Backs the agent recap's "Dead ends" section. */
  | 'turn_internals'
  /** Per-conversation `set_status` (the agent's own structured end-of-turn claim:
   *  state + done/pending/blocked, often citing the commit hash). The
   *  highest-confidence recap signal -- trusted over transcript inference, with a
   *  SUPERSEDED status (later user impulse) flagged and not read as final. Cheap
   *  (one indexed read); IN DEFAULT_SIGNALS. Also carries best-effort spawn-lineage
   *  provenance (root hash) so chained conversations fold into one storyline. */
  | 'agent_status'

/** Who a recap is written for. 'human' = narrative report (default).
 *  'agent' = terse orientation brief for a fresh Claude Code session. */
export type RecapAudience = 'human' | 'agent'

export interface RecapMeta {
  recapId: string
  projectUri: string
  periodLabel: RecapPeriodLabel
  periodStart: number
  periodEnd: number
  timeZone: string
  audience: RecapAudience
  status: RecapStatus
  progress: number
  phase?: string
  model?: string
  inputChars: number
  inputTokens: number
  outputTokens: number
  llmCostUsd: number
  title?: string
  subtitle?: string
  error?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  /** COST 2 -- per-call engine-cost ledger (oneshot/map/reduce/retry).
   *  Absent on pre-ledger recaps; llmCostUsd remains the aggregate. */
  costLedger?: RecapCostLedger
}

export interface RecapSummary {
  id: string
  projectUri: string
  periodLabel: RecapPeriodLabel
  periodStart: number
  periodEnd: number
  audience: RecapAudience
  status: RecapStatus
  title?: string
  subtitle?: string
  createdAt: number
  completedAt?: number
  llmCostUsd: number
  model?: string
  progress: number
  phase?: string
  error?: string
  /** True when this recap currently has an active (non-expired) public share
   *  token. Server-computed in `GET /api/recaps` so the list can show a shared
   *  indicator. See plan-recap-share-leak.md. */
  isShared?: boolean
}

/** One cited item in a recap section (feature/bug/fix/incident/decision/...).
 *  `inferred` mirrors the agent brief's FACT-vs-INFERENCE rule: true when the
 *  claim is concluded from transcript text rather than backed by a commit/task. */
export interface RecapItem {
  title: string
  detail?: string
  conversations?: string[]
  commits?: string[]
  inferred?: boolean
  /** Outcome of a discovered technology/approach. Populated only for
   *  `tech_discovered` items (the Lessons Scavenger's cross-project tech
   *  registry keys on it: "we used X in project Y with success"). Omitted
   *  elsewhere. 'mixed' = a code-merge saw both a success and a failure. */
  outcome?: 'success' | 'failure' | 'mixed'
}

/** Structured frontmatter the LLM emits, parsed and persisted as metadata_json.
 *  This IS the search index AND (as of Recap 2.0) the primary render surface. */
export interface RecapMetadata {
  subtitle?: string
  keywords: string[]
  hashtags: string[]
  goals: string[]
  discoveries: string[]
  side_effects: string[]
  features: RecapItem[]
  bugs: RecapItem[]
  fixes: RecapItem[]
  incidents: RecapItem[]
  /** Non-obvious decisions made + WHY (the reasoning a diff cannot show). */
  decisions: RecapItem[]
  /** Approaches tried and ABANDONED + why they failed. git keeps no record. */
  dead_ends: RecapItem[]
  /** Constraints/landmines discovered: tool quirks, env quirks, failure modes. */
  gotchas: RecapItem[]
  /** Moments the USER voiced frustration/friction (repeated failures, "still
   *  broken", going in circles, wasted time, a tool fighting back). Observed
   *  from the user's own words, NOT inferred -- map-stage extraction. Distinct
   *  from went_badly (Opus's retrospective judgment of what was inefficient). */
  frustrations: RecapItem[]
  open_questions: string[]
  stakeholders: string[]
  /** Pillar F (retrospect mode): evaluative judgment emitted ONLY when
   *  recap_create sets retrospect:true. Opus-derived (ONESHOT / CHUNKED:Final),
   *  never the map stage. Absent on non-retrospect recaps. */
  went_well?: RecapItem[]
  went_badly?: RecapItem[]
  /** Actionable improvements for next period -- the feed into CLAUDE.md/rules/tools. */
  recommendations?: RecapItem[]
  /** Lessons Scavenger: technologies/libraries/tools/approaches discovered or
   *  adopted, each with an `outcome` (success/failure/mixed) and citations.
   *  OPTIONAL + absent from makeEmptyMetadata on purpose -- only the
   *  lessons-learned template requests it, so every other recap (and the
   *  byte-pinned prompt goldens) stay unchanged. Aggregated fleet-wide into the
   *  cross-project tech registry by Tier-2 compaction. */
  tech_discovered?: RecapItem[]
}

export interface RecapDigestConversation {
  id: string
  title: string
  turns: number
  status: string
  costUsd?: number
  /** Epoch ms the conversation was created / last updated. Deterministic source
   *  pointers (from gatherConversations) so every recap's source roster is
   *  timestamped for drill-down into the live transcript. */
  createdAt?: number
  updatedAt?: number
}

export interface RecapDigestDay {
  day: string
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Cache-write (prompt-cache re-warm) tokens for the day. Pillar E surfaces
   *  the re-warm tax as a time series; the old projection dropped this. */
  cacheWriteTokens: number
  turns: number
}

export interface RecapDigestModel {
  model: string
  costUsd: number
  tokens: number
  turns: number
}

export interface RecapDigestCommits {
  total: number
  filesChanged: number
  insertions: number
  deletions: number
}

/** Pillar E COST 1 -- mechanical activity rollups for the customer-facing
 *  showcase. Tool calls split read/edit/write/bash; incidents from the error
 *  digest; conversations/turns from the conversation digest. */
export interface RecapDigestActivity {
  conversations: number
  turns: number
  toolCalls: { total: number; read: number; edit: number; write: number; bash: number; other: number }
  incidents: number
}

/** Pillar E -- one context-window band. The cost-penalty-of-long-context curve
 *  is costUsd/conversations across the ascending bands. */
export interface RecapDigestContextBucket {
  bucket: string
  lowerTokens: number
  conversations: number
  costUsd: number
  cacheWriteTokens: number
  turns: number
}

/** Curated, wire-safe projection of the gather digests for chart + drill-down
 *  rendering. Persisted as digest_json. Absent on pre-2.0 recaps (degrade to
 *  the markdown body). */
export interface RecapDigest {
  cost: {
    totalCostUsd: number
    totalTurns: number
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    totalCacheWriteTokens: number
    perDay: RecapDigestDay[]
    perModel: RecapDigestModel[]
  }
  conversations: RecapDigestConversation[]
  commits?: RecapDigestCommits
  /** Pillar E COST 1: mechanical activity showcase. Absent on pre-2.1 recaps. */
  activity?: RecapDigestActivity
  /** Pillar E: conversations bucketed by peak context + the cost they carried.
   *  Absent on pre-2.1 recaps. */
  contextBuckets?: RecapDigestContextBucket[]
}

/** Which LLM cost source a ledger entry's cost came from. Mirrors the
 *  broker-side NormalizedUsage.costSource (openrouter = real billed cost via
 *  usage.include; litellm = price-table estimate; unknown = no pricing). */
export type RecapLedgerCostSource = 'openrouter' | 'litellm' | 'unknown'

/** The pipeline stage that issued one LLM call. */
export type RecapLedgerStage = 'oneshot' | 'map' | 'reduce' | 'retry'

/** One LLM call in a recap run -- COST 2 (what the recap ENGINE spent),
 *  distinct from COST 1 (what the project spent, in RecapDigest.cost).
 *  Recorded for EVERY call including failures, so a failed recap shows the
 *  tokens it burned instead of $0. */
export interface RecapLedgerEntry {
  stage: RecapLedgerStage
  /** Map-stage chunk index (0-based); omitted for non-map stages. */
  chunkIndex?: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Billed input/output cost split when OpenRouter cost_details was present. */
  inputCostUsd?: number
  outputCostUsd?: number
  costUsd: number
  costSource: RecapLedgerCostSource
  /** Wall-clock duration of the call in ms. */
  ms: number
  /** False if the call threw (timeout/4xx/5xx); cost may still be 0 then. */
  ok: boolean
  error?: string
}

export interface RecapLedgerSummary {
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  callCount: number
  /** Distinct models used across the run, in first-seen order. */
  models: string[]
  /** Per-stage rollup (calls + cost) for the "where did the money go" view. */
  byStage: Partial<Record<RecapLedgerStage, { calls: number; costUsd: number }>>
}

/** COST 2 ledger persisted as ledger_json + surfaced on the recap. */
export interface RecapCostLedger {
  /** Bumped when the entry shape changes; lets readers degrade gracefully. */
  version: number
  entries: RecapLedgerEntry[]
  summary: RecapLedgerSummary
}

export interface PeriodRecapDoc extends RecapMeta {
  markdown?: string
  /** Structured frontmatter (cards, chips). Absent on pre-2.0 recaps. */
  metadata?: RecapMetadata
  /** Charts + drill-down projection. Absent on pre-2.0 recaps. */
  digest?: RecapDigest
}

export interface RecapLogEntry {
  id: number
  recapId: string
  timestamp: number
  level: RecapLogLevel
  phase: string
  message: string
  data?: unknown
}

export interface RecapCreateMessage {
  type: 'recap_create'
  projectUri: string
  period: { label: RecapPeriodLabel; start?: number; end?: number }
  timeZone: string
  signals?: RecapSignal[]
  force?: boolean
  /** Named presentation template id (recap-templates/<id>.yml). Selects the
   *  deliverable shape; templates re-present, they NEVER re-extract. Defaults to
   *  'project-recap' (the byte-identical anchor). A missing id falls back to the
   *  default. See plan-recap-templates.md. */
  template?: string
  /** User overrides of the selected template's declared option defaults
   *  (option id -> boolean). Unknown keys are ignored; only declared options
   *  resolve. A "prompt-tweak" option flips a Liquid `options.<id>` boolean; a
   *  "technical" option (declares a signal) additionally adds/removes a gather
   *  signal. */
  options?: Record<string, boolean>
  /** Audience the recap is written for. Defaults to 'human' (narrative report).
   *  The MCP entry point defaults it to 'agent'. */
  audience?: RecapAudience
  /** Pillar F: when true, the Opus synthesis additionally emits an evaluative
   *  retrospective (went_well/went_badly/recommendations + a body section) on top
   *  of the chosen audience. Opt-in, NOT benevolent-gated; a product mode. */
  retrospect?: boolean
  /** When true, the Opus synthesis sanitizes the recap for sharing OUTSIDE the
   *  team: the frustrations section is dropped and harsh/blaming/profane language
   *  is reframed neutral + constructive. Facts + citations are preserved; only the
   *  voice changes. Opt-in, NOT benevolent-gated; a product mode like retrospect. */
  customerFriendly?: boolean
  /** When true, the broker records the calling conversation and pushes a
   *  recap-completed channel message to it when the run finishes, instead of
   *  the caller polling recap_get. The conversationId is derived broker-side
   *  from the WS connection -- callers never pass their own id. */
  inform_on_complete?: boolean
  /** Optional. When set, the broker echoes it on recap_created/recap_error so
   *  MCP-side broker-rpc can correlate the response. Dashboard callers omit it. */
  requestId?: string
  /** Optional batch correlation id for fan-out from batch command palette.
   *  Broker logs it; never interpreted. */
  batchId?: string
  /** Pillar D: benevolent-gated eval-harness tuning. All optional; each recap
   *  resolves + persists its full recipe (args_json) so variants are comparable. */
  tuning?: RecapTuning
}

/** Per-stage numeric knob (map / reduce / oneshot). */
export interface RecapStageParam {
  map?: number
  reduce?: number
  oneshot?: number
}

/** Eval-harness tuning overrides for recap_create. Every field is optional and
 *  falls back to env/defaults; the RESOLVED values are stored on the recap row
 *  (args_json) so a benevolent robot can compare variants by recipe + cost. */
export interface RecapTuning {
  /** Label to tell variants apart in the recap list (suffixed onto the title). */
  variantLabel?: string
  /** Force the render path regardless of input size (A/B chunked vs oneshot). */
  forceMode?: 'auto' | 'oneshot' | 'chunked'
  /** Per-stage model slugs (OpenRouter). */
  mapModel?: string
  reduceModel?: string
  oneshotModel?: string
  /** Chunk-mode gate overrides. */
  thresholdChars?: number
  thresholdConvs?: number
  /** Greedy chunk size (chars). */
  chunkSize?: number
  /** Per-stage sampling temperature. */
  temperature?: RecapStageParam
  /** Per-stage max output tokens. */
  maxTokens?: RecapStageParam
}
/** Pillar C++: re-run a recap from a downstream stage off its on-disk bundle
 *  (Pillar C+). Benevolent-gated like recap_create. Version-gated server-side. */
export interface RecapRegenerateMessage {
  type: 'recap_regenerate'
  recapId: string
  /** synthesize = 1 LLM call on the saved merged JSON / oneshot prompt;
   *  render/html = zero-LLM re-render from the saved final response. */
  from: 'synthesize' | 'render' | 'html'
  /** fork (default) = new recapId, copies upstream artifacts; in-place = refine. */
  mode?: 'fork' | 'in-place'
  /** Optional synthesize-stage model override (eval-harness lever). */
  model?: string
  /** Echoed on recap_regenerated/recap_error so MCP broker-rpc can correlate. */
  requestId?: string
}
/** Reply to recap_regenerate. The broker mints `recapId` (a new fork in
 *  mode:fork, the same id in-place) and echoes the lineage so callers can
 *  switch to / group the variant. Sent back over the originating connection. */
export interface RecapRegeneratedMessage {
  type: 'recap_regenerated'
  recapId: string
  sourceRecapId?: string
  mode: 'fork' | 'in-place'
  from: 'synthesize' | 'render' | 'html'
  requestId?: string
}
export interface RecapCancelMessage {
  type: 'recap_cancel'
  recapId: string
}
/** G3: resume an interrupted/partial/failed chunked recap (reuse paid chunks). */
export interface RecapResumeMessage {
  type: 'recap_resume'
  recapId: string
}
/** Reply to recap_resume. resumeCount is the post-increment attempt number. */
export interface RecapResumedMessage {
  type: 'recap_resumed'
  recapId: string
  resumeCount: number
  reusableChunks: number
  totalChunks: number
}
export interface RecapDismissFailedMessage {
  type: 'recap_dismiss_failed'
  recapId: string
}
export interface RecapListMessage {
  type: 'recap_list'
  projectUri?: string
  status?: RecapStatus[]
  limit?: number
}
export interface RecapGetMessage {
  type: 'recap_get'
  recapId: string
  includeLogs?: boolean
}
export interface RecapProgressMessage {
  type: 'recap_progress'
  recapId: string
  status: RecapStatus
  progress: number
  phase: string
  log?: { level: RecapLogLevel; message: string; ts: number; data?: unknown }
}
export interface RecapCreatedMessage {
  type: 'recap_created'
  recapId: string
  cached: boolean
  requestId?: string
}
export interface RecapErrorMessage {
  type: 'recap_error'
  error: string
  requestId?: string
}
export interface RecapCompleteMessage {
  type: 'recap_complete'
  recapId: string
  title: string
  markdown: string
  meta: RecapMeta
}
export interface RecapListResultMessage {
  type: 'recap_list_result'
  recaps: RecapSummary[]
}
export interface RecapGetResultMessage {
  type: 'recap_get_result'
  recap: PeriodRecapDoc
  logs?: RecapLogEntry[]
}

// MCP RPC pass-through: agent host -> broker -> agent host
export interface RecapSearchRequest {
  type: 'recap_search_request'
  requestId: string
  query: string
  projectFilter?: string
  tags?: string[]
  limit?: number
}
export interface RecapSearchHit {
  id: string
  projectUri: string
  periodLabel: RecapPeriodLabel
  periodStart: number
  periodEnd: number
  title: string
  subtitle: string
  snippet: string
  score: number
  createdAt: number
}
export interface RecapSearchResult {
  type: 'recap_search_result'
  requestId: string
  ok: boolean
  results?: RecapSearchHit[]
  error?: string
}
export interface RecapMcpGetRequest {
  type: 'recap_mcp_get_request'
  requestId: string
  recapId: string
}
export interface RecapMcpGetResult {
  type: 'recap_mcp_get_result'
  requestId: string
  ok: boolean
  recap?: PeriodRecapDoc
  error?: string
}
export interface RecapMcpListRequest {
  type: 'recap_mcp_list_request'
  requestId: string
  projectFilter?: string
  limit?: number
}
export interface RecapMcpListResult {
  type: 'recap_mcp_list_result'
  requestId: string
  ok: boolean
  recaps?: RecapSummary[]
  error?: string
}
/** One declared input/knob of a recap template. A "prompt-tweak" option (no
 *  `signal`) flips a Liquid `options.<id>` boolean in the body; a "technical"
 *  option additionally adds/removes a gather signal. */
export interface RecapTemplateOptionInfo {
  id: string
  label: string
  default: boolean
  signal?: RecapSignal
}
/** A recap presentation template + its declared inputs, as surfaced to callers
 *  (the discovery shape behind `recap_templates` + GET /api/recap-templates). The
 *  Liquid body is internal and deliberately omitted. */
export interface RecapTemplateInfo {
  id: string
  label: string
  description: string
  scope: 'fleet'
  audience: RecapAudience
  sections: string[]
  defaults: { retrospect: boolean; customerFriendly: boolean; signals: RecapSignal[] }
  options: RecapTemplateOptionInfo[]
  isDefault: boolean
}
/** MCP RPC pass-through: enumerate the available presentation templates + their
 *  declared options, so a caller knows which `template` ids + `options` keys
 *  recap_create accepts. Read-only built-in fleet metadata -- NOT project data,
 *  so no per-project scope and no benevolent-trust gate. Optional `audience`
 *  narrows the list to human- or agent-oriented templates. */
export interface RecapTemplatesRequest {
  type: 'recap_templates_request'
  requestId: string
  audience?: RecapAudience
}
export interface RecapTemplatesResult {
  type: 'recap_templates_result'
  requestId: string
  ok: boolean
  templates?: RecapTemplateInfo[]
  defaultTemplateId?: string
  error?: string
}

// Configuration
export const DEFAULT_BROKER_URL = 'ws://localhost:9999'

/** Query params the sentinel sets on its DEDICATED shell-data WebSocket so the
 *  broker can tell that socket apart from the control WS and pair it back to the
 *  owning sentinel (plan-host-shell.md 2/3, the "dedicated data plane" pick).
 *  `SHELL_DATA_WS_FLAG=1` marks the socket; `SHELL_DATA_WS_SENTINEL` carries the
 *  sentinel's stable machine id. Auth reuses the usual `?secret=` param. */
export const SHELL_DATA_WS_FLAG = 'shellData'
export const SHELL_DATA_WS_SENTINEL = 'shellDataSentinel'
export const DEFAULT_BROKER_PORT = 9999
export const HEARTBEAT_INTERVAL_MS = 30000
// Conversation status is driven by hooks (active/idle/ended), no configurable timeout
// Server evaluates idle status - clients trust conversation.status
