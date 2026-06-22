// Re-export shared types (single source of truth)
export type {
  AgentHostCapability,
  ArchivedTaskGroup,
  BgTaskInfo as BgTaskSummary,
  ClaudeEfficiencyUpdate,
  ClaudeHealthUpdate,
  ConnectionInfo,
  ConnectionRole,
  ExtraUsage,
  LaunchConfig,
  LiveStatus,
  LiveStatusState,
  MonitorInfo,
  ProfileUsageSnapshot,
  ProjectSettings,
  SubagentInfo,
  TaskInfo,
  UsageUpdate,
  UsageWindow,
} from '@shared/protocol'

import type {
  AgentHostCapability,
  BgTaskInfo as BgTaskSummary,
  ConversationTaskFields,
  LaunchConfig,
  LiveStatus,
  MonitorInfo,
  ProjectSettings,
} from '@shared/protocol'

// Re-export HookEvent but with a looser data type for generic property access
// (dashboard does e.data?.model, e.data?.tool_name, etc.)
export type { HookEvent } from '@shared/protocol'

/** Check if a conversation can open a terminal. Requires explicit terminal capability. */
export function canTerminal(s: Conversation): boolean {
  return s.status !== 'ended' && !!s.capabilities?.includes('terminal')
}

/** Check if a conversation supports raw JSON stream viewing. */
export function canJsonStream(s: Conversation): boolean {
  return s.status !== 'ended' && !!s.capabilities?.includes('json_stream')
}

/** Check if a host shell can be opened on this conversation's sentinel. Driven by
 *  the host sentinel's `features.shell` (joined onto `shellCapable` by the
 *  broker), NOT by the agent-host terminal capability -- shells are a sentinel
 *  feature, independent of PTY/headless mode. */
export function canShell(s: Conversation): boolean {
  return s.status !== 'ended' && !!s.shellCapable
}

// Client-side conversation model (derived from SessionSummary wire format with defaults applied).
// Task fields live in the shared ConversationTaskFields (single source of truth with the broker
// wire type). The web builder in use-websocket-handlers.ts defaults every one of them
// (`?? 0` / `?? []`), so they are always populated -- hence required here, not optional.
export interface Conversation extends ConversationTaskFields {
  id: string
  project: string
  /** Live working directory CC is using right now. `project` stays pinned to the
   *  launch URI; `currentPath` shifts when the agent enters/exits a worktree (or
   *  cd's around). Drives the worktree indicator in the header. Server mirror:
   *  `Conversation.currentPath`. */
  currentPath?: string
  /** Sentinel-profile NAME the sentinel resolved at spawn time. `undefined`
   *  means default profile. Mirrors `Conversation.resolvedProfile` server-side. */
  resolvedProfile?: string
  model?: string
  capabilities?: AgentHostCapability[]
  version?: string
  buildTime?: string
  connectionIds?: string[]
  status: 'active' | 'idle' | 'ended' | 'starting' | 'booting'
  compacting?: boolean
  compactedAt?: number
  startedAt: number
  lastActivity: number
  eventCount: number
  activeSubagentCount: number
  totalSubagentCount: number
  subagents: Array<{
    agentId: string
    agentType: string
    description?: string
    /** Cheap Tier-0 roster field (Phase B). Big launch prompt lives in the agent
     *  sub-stream, never on this broadcast card. */
    model?: string
    status: 'running' | 'stopped'
    startedAt: number
    stoppedAt?: number
    eventCount: number
    tokenUsage?: { totalInput: number; totalOutput: number; cacheCreation: number; cacheRead: number }
  }>
  // taskCount / pendingTaskCount / activeTasks / pendingTasks / completedTaskCount /
  // completedTasks / archivedTaskCount / archivedTasks / taskSubjects come from
  // ConversationTaskFields (shared with the broker ConversationSummary wire type).
  runningBgTaskCount: number
  bgTasks: BgTaskSummary[]
  monitors?: MonitorInfo[]
  runningMonitorCount?: number
  teammates: Array<{
    name: string
    status: 'idle' | 'working' | 'stopped'
    currentTaskSubject?: string
    completedTaskCount: number
  }>
  team?: { teamName: string; role: 'lead' | 'teammate' }
  effortLevel?: string
  permissionMode?: string
  lastError?: { stopReason?: string; errorType?: string; errorMessage?: string; timestamp: number }
  /**
   * Set ONLY for actual rate limits. NOT set for notices (e.g. 7-day soft warnings).
   */
  rateLimit?: {
    retryAfterMs?: number
    /** Epoch ms when the bucket resets (UI live formatter source). */
    resetsAt?: number
    message: string
    timestamp: number
    /** Resolved sentinel-profile name -- which account hit the limit. */
    profile?: string
    /** Sentinel hosting that profile. */
    sentinelId?: string
    /** Denormalized human-readable sentinel alias for UI display. */
    sentinelAlias?: string
  }
  planMode?: boolean
  pendingAttention?: {
    type: 'permission' | 'elicitation' | 'ask' | 'dialog' | 'plan_approval' | 'spawn_approval'
    toolName?: string
    filePath?: string
    question?: string
    timestamp: number
  }
  /** THE STATUS — agent self-reported task state; drives the attention badge. */
  liveStatus?: LiveStatus
  pendingSpawnApproval?: {
    requestId: string
    requestedAt: number
    request: Record<string, unknown>
    reason: string
  }
  spawnAutoApproved?: boolean
  hasNotification?: boolean
  tokenUsage?: { input: number; cacheCreation: number; cacheRead: number; output: number }
  contextWindow?: number
  cacheTtl?: '5m' | '1h'
  lastTurnEndedAt?: number
  summary?: string
  title?: string
  description?: string
  agentName?: string
  prLinks?: Array<{ prNumber: number; prUrl: string; prRepository: string; timestamp: string }>
  linkedProjects?: Array<{ project: string; name: string }>
  linkedConversations?: Array<{ conversationId: string; name: string }>
  stats?: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheCreation: number
    totalCacheWrite5m?: number
    totalCacheWrite1h?: number
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
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
  gitBranch?: string
  spinnerVerbs?: string[]
  autocompactPct?: number
  adHocTaskId?: string
  adHocWorktree?: string
  launchConfig?: LaunchConfig
  resultText?: string
  recap?: { content: string; title?: string; name?: string; timestamp: number }
  recapFresh?: boolean
  lastEvent?: {
    hookEvent: string
    timestamp: number
  }
  hostSentinelId?: string
  hostSentinelAlias?: string
  /** Host sentinel advertises `features.shell` -- can open a host shell here.
   *  Joined by the broker via `hostSentinelId`. See [[canShell]]. */
  shellCapable?: boolean
  /** Agent family (claude / opencode / chat-api / hermes). The daemon is NOT a
   *  backend -- it is the claude `claude-daemon` transport below. */
  backend?: string
  /** Resolved transport (transport reframe): 'claude-pty' | 'claude-headless'
   *  | 'claude-daemon'. The canonical discriminator the control panel keys
   *  daemon-specific UI off. */
  transport?: string
  /** Direct spawner conversationId. NULL/absent = self-rooted (human-started).
   *  Stable for the conversation's lifetime. See plan-spawn-parent-tracking.md. */
  parentConversationId?: string
  /** Topmost ancestor in the spawn chain. Grouping key for project-list
   *  visual grouping: COALESCE(rootConversationId, id). */
  rootConversationId?: string
  /** Number of conversations whose parentConversationId == this.id. REST-only
   *  field (set by /conversations + /conversations/:id); WS updates omit it
   *  -- consumers needing live count derive it from the local list (O(N)). */
  directChildCount?: number
  /** NIGHTSHIFT origin tag (mirrors server `ConversationSummary.nightshift`).
   *  Present => an unattended night-run task; the live Status screen filters
   *  night rows on this. Carries only run/task ids, no launch internals. */
  nightshift?: { runId: string; taskId: string }
}

// Project order tree types -- each leaf is a project keyed by project URI
// (e.g. "claude:///Users/jonas/projects/foo"). Legacy entries may still use
// "cwd:<path>" format; consumers should handle both (legacy compat).
export interface ProjectOrderGroup {
  id: string
  type: 'group'
  name: string
  children: ProjectOrderNode[]
  isOpen?: boolean
}

interface ProjectOrderProject {
  id: string // project URI (e.g. "claude:///path") or legacy "cwd:<path>" (compat)
  type: 'project'
}

export type ProjectOrderNode = ProjectOrderGroup | ProjectOrderProject

export interface ProjectOrder {
  tree: ProjectOrderNode[]
}

// Nested groups aren't supported by the renderer. Flatten any group nested inside
// another group by hoisting it to root and promoting its own children. Idempotent.
export function flattenProjectOrderTree(tree: ProjectOrderNode[]): ProjectOrderNode[] {
  const roots: ProjectOrderNode[] = []
  const nestedGroups: ProjectOrderGroup[] = []
  for (const node of tree) {
    if (node.type === 'group') {
      const leaves: ProjectOrderNode[] = []
      for (const child of node.children) {
        if (child.type === 'group') nestedGroups.push(child)
        else leaves.push(child)
      }
      roots.push({ ...node, children: leaves })
    } else {
      roots.push(node)
    }
  }
  for (const g of nestedGroups) {
    const leaves: ProjectOrderNode[] = []
    for (const child of g.children) {
      if (child.type === 'group') nestedGroups.push(child)
      else leaves.push(child)
    }
    roots.push({ ...g, children: leaves })
  }
  return roots
}

export function projectOrderTreesEqual(a: ProjectOrderNode[], b: ProjectOrderNode[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface TranscriptImage {
  hash: string
  ext: string
  url: string
  originalPath: string
}

// Re-export all typed entry variants from shared protocol
export type {
  TranscriptAssistantEntry,
  TranscriptContentBlock,
  TranscriptEntry,
  TranscriptQueueEntry,
  TranscriptUserEntry,
} from '@shared/protocol'

// Frontend-specific rendering extensions on transcript entries.
// The JSONL entries are augmented by the broker/dashboard with
// images and structured tool results before rendering.
export interface TranscriptToolUseResult {
  filePath?: string
  oldString?: string
  newString?: string
  structuredPatch?: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>
}

/** Project settings keyed by project URI (e.g. "claude:///Users/jonas/projects/foo") */
export type ProjectSettingsMap = Record<string, ProjectSettings>

/**
 * Extract the filesystem path from a project URI.
 * e.g. "claude:///Users/jonas/foo" -> "/Users/jonas/foo"
 * Duplicated from src/shared/project-uri.ts since web bundle can't import from src/shared/.
 */
export function projectPath(uri: string): string {
  if (!uri) return ''
  try {
    const url = new URL(uri)
    return decodeURIComponent(url.pathname) || '/'
  } catch {
    return uri
  }
}

// cwdToProjectUri + extractProjectLabel re-export from the shared module.
// Web previously kept divergent stubs under a "can't import from src/shared/"
// rationale that no longer applies (the @shared/* path alias works).
export { cwdToProjectUri, extractProjectLabel } from '@shared/project-uri'
