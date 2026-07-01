/**
 * Shared context object passed to extracted agent host modules.
 * Holds mutable references to shared state so modules can read/write
 * without needing globals or circular imports.
 */

import type { TreeWatcher } from '../shared/fs-watch'
import type {
  AgentHostLaunchEvent,
  AgentHostLaunchPhase,
  AgentHostMessage,
  HookEvent,
  TranscriptEntry,
} from '../shared/protocol'
import type { PtyProcess } from './pty-spawn'
import type { StreamProcess } from './stream-backend'
import type { TranscriptWatcher } from './transcript-watcher'
import type { WsClient } from './ws-client'

/**
 * An outstanding user-facing interaction whose response is held in broker
 * memory. Stored on the agent host so we can re-send on every (re)connect — a
 * broker restart mid-interaction would otherwise strand CC/MCP forever.
 * Kinds: permission_request, ask_question, dialog_show, plan_approval.
 */
export interface OutstandingInteraction {
  kind: 'permission_request' | 'ask_question' | 'dialog_show' | 'plan_approval'
  id: string
  payload: AgentHostMessage
  createdAt: number
}

export interface AgentHostContext {
  // Identity
  readonly conversationId: string
  readonly cwd: string

  // Mode flags (immutable after startup)
  readonly headless: boolean
  readonly channelEnabled: boolean
  readonly noBroker: boolean

  // Mutable session state
  claudeSessionId: string | null
  pendingClearFromId: string | null
  clearRequested: boolean
  /** UUID for the currently-running launch. Rotates on every /clear reboot so
   *  the dashboard can group launch events into their own timeline. */
  currentLaunchId: string
  /** Phase of the current launch. 'initial' on first spawn, flips to 'reboot'
   *  when a /clear starts a new launch. The 'live' phase is never used by
   *  the agent host itself -- it's reserved for broker-synthesized
   *  change events (model_changed, mcp_servers_changed, etc.) that are
   *  appended directly to the transcript server-side. */
  currentLaunchPhase: AgentHostLaunchPhase
  /** Persistent, append-only log of every launch event emitted so far.
   *  Re-sent on WS reconnect so the dashboard catches up. */
  readonly launchEvents: Array<AgentHostLaunchEvent>
  terminalAttached: boolean
  jsonStreamAttached: boolean
  readonly jsonStreamBuffer: string[]
  resumeId: string | null
  /** FORK: launched with `--fork-session` -- CC branched a new session off
   *  `resumeId` and writes the forked history to a NEW session file, so the
   *  transcript path is derived from the observed (new) session id, not resumeId. */
  forkSession: boolean
  parentTranscriptPath: string | null
  syntheticUserUuids: Map<string, string>
  lastTasksJson: string

  /** Last cwd we emitted a `cwd_changed` message for (from any source: CC's
   *  CwdChanged hook or an EnterWorktree/ExitWorktree tool result). Dedup guard
   *  so repeats/replays don't re-emit. Undefined until the first move. See
   *  emitCwdChanged in worktree-detect.ts. */
  lastEmittedCwd?: string

  /** Timestamp (ms) of the most recent dashboard-approved ExitPlanMode. Used
   *  to suppress stale `system/status` messages that still carry
   *  `permissionMode: 'plan'` after the user has approved the exit but before
   *  CC's internal mode transitions. Cleared once we observe a status with
   *  `permissionMode !== 'plan'` (or after a short window). 0 = inactive. */
  planExitApprovedAt: number

  // Process references
  wsClient: WsClient | null
  ptyProcess: PtyProcess | null
  streamProc: StreamProcess | null

  // Watchers
  taskWatcher: TreeWatcher | null
  taskCandidateDirs: string[]
  transcriptWatcher: TranscriptWatcher | null
  readonly subagentWatchers: Map<string, TranscriptWatcher>
  /** agent_ids of subagents currently in flight (added on SubagentStart, removed
   *  on SubagentStop). Insertion-ordered. Used by the hook seam to tag
   *  subagent-originated hooks with a running subagent's id so the broker keeps
   *  their side effects off the parent conversation -- see HookEvent.subagentId
   *  and plan-subagent-hook-containment.md. */
  readonly runningSubagents: Set<string>
  readonly bgTaskOutputWatchers: Map<string, { stop: () => void }>

  // THE STATUS — per-turn counters for the Stop-hook set_status nudge. Reset on
  // UserPromptSubmit. `statusSetThisTurn` is set when the agent calls set_status.
  // `mutatedThisTurn` flips on the first file-mutating tool (Edit/Write/...);
  // `toolCallsThisTurn` counts every tool use. The Stop hook only nudges when the
  // turn was SUBSTANTIAL (a mutation, or a busy multi-tool turn) and no status was
  // set — small read/lookup/chatter turns are never nudged. And even then the
  // nudge is a non-coercive reminder: the agent makes the judgment call.
  statusSetThisTurn: boolean
  mutatedThisTurn: boolean
  toolCallsThisTurn: number

  // Caches
  readonly pendingEditInputs: Map<string, { oldString: string; newString: string }>
  readonly pendingReadPaths: Map<string, string> // tool_use_id -> file_path for image upload
  readonly pendingAskRequests: Map<
    string,
    { requestId: string; questions: unknown[]; timer?: ReturnType<typeof setTimeout> }
  >
  /** tool_use_id -> Claude tool name. Populated by the dialect translator
   *  on each tool_use block; consumed when the matching tool_result block
   *  arrives so the result envelope mapper knows the source tool kind. */
  readonly toolNameByUseId: Map<string, string>

  // Transcript entries received before claudeSessionId was set (e.g. initial prompt in headless mode).
  // Flushed by session-transition once claudeSessionId becomes available.
  readonly pendingTranscriptEntries: Array<{ entries: TranscriptEntry[]; isInitial: boolean; agentId?: string }>

  // Event queue
  readonly eventQueue: HookEvent[]

  // Pending session name (sent when WS connects)
  pendingConversationName?: { name: string; userSet: boolean; description?: string }

  // Outstanding user interactions (permission_request / ask_question /
  // dialog_show / plan_approval) keyed by their id. Full payload is kept
  // verbatim; re-sent on every (re)connect so a broker restart
  // mid-interaction doesn't strand CC/MCP waiting for a user response.
  readonly outstandingInteractions: Map<string, OutstandingInteraction>

  // Diagnostics
  readonly diagBuffer: Array<{ t: number; type: string; msg: string; args?: unknown }>
  diagFlushTimer: ReturnType<typeof setTimeout> | null

  // Functions provided by index.ts
  diag: (type: string, msg: string, args?: unknown) => void
  flushDiag: () => void
  debug: (msg: string) => void
  connectToBroker: (ccSessionId: string | null) => void
  startTaskWatching: () => void
  readTasks: () => void
  startTranscriptWatcher: (transcriptPath: string) => void
  startSubagentWatcher: (agentId: string, transcriptPath: string, live: boolean) => void
  stopSubagentWatcher: (agentId: string) => void
  sendTranscriptEntriesChunked: (entries: TranscriptEntry[], isInitial: boolean, agentId?: string) => void

  // Upload a blob to the broker blob store, returns URL or null on failure
  uploadBlob: ((data: Uint8Array, mediaType: string) => Promise<string | null>) | null
}
