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
  FileInfo,
  HookEventType,
  LaunchConfig,
  MonitorInfo,
  ProfileUsageSnapshot,
  ProjectSettings,
  SubagentInfo,
  TaskInfo,
  TeamInfo,
  UsageUpdate,
  UsageWindow,
} from '@shared/protocol'

import type {
  AgentHostCapability,
  BgTaskInfo as BgTaskSummary,
  LaunchConfig,
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

// Client-side conversation model (derived from SessionSummary wire format with defaults applied)
export interface Conversation {
  id: string
  project: string
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
    status: 'running' | 'stopped'
    startedAt: number
    stoppedAt?: number
    eventCount: number
    tokenUsage?: { totalInput: number; totalOutput: number; cacheCreation: number; cacheRead: number }
  }>
  taskCount: number
  pendingTaskCount: number
  activeTasks: Array<{ id: string; subject: string }>
  pendingTasks: Array<{ id: string; subject: string }>
  archivedTaskCount?: number
  archivedTasks?: Array<{ id: string; subject: string }>
  taskSubjects?: Record<string, string>
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
  recap?: { content: string; title?: string; timestamp: number }
  recapFresh?: boolean
  lastEvent?: {
    hookEvent: string
    timestamp: number
  }
  hostSentinelId?: string
  hostSentinelAlias?: string
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
  TranscriptAssistantMessage,
  TranscriptCompactingEntry,
  TranscriptContentBlock,
  TranscriptEntry,
  TranscriptProgressEntry,
  TranscriptQueueEntry,
  TranscriptSystemEntry,
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

/**
 * Convert a filesystem path to a project URI.
 * e.g. "/Users/jonas/foo" -> "claude:///Users/jonas/foo"
 * Duplicated from src/shared/project-uri.ts since web bundle can't import from src/shared/.
 */
export function cwdToProjectUri(cwd: string): string {
  return `claude://${cwd}`
}

/**
 * Extract a human-readable label from a project URI.
 * Returns the last path segment (e.g. "claude:///Users/jonas/foo" -> "foo").
 * Duplicated from src/shared/project-uri.ts since web bundle can't import from src/shared/.
 */
export function extractProjectLabel(uri: string): string {
  if (!uri || uri === '*') return uri || ''
  try {
    const url = new URL(uri)
    const segments = decodeURIComponent(url.pathname).split('/').filter(Boolean)
    return segments.length > 0 ? segments[segments.length - 1] : uri
  } catch {
    // Legacy "cwd:<path>" format or plain path
    const path = uri.startsWith('cwd:') ? uri.slice(4) : uri
    const segments = path.split('/').filter(Boolean)
    return segments.length > 0 ? segments[segments.length - 1] : uri
  }
}
