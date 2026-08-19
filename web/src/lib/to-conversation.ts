/**
 * The one wire-summary -> Conversation mapper.
 *
 * Lifted out of use-websocket-handlers.ts so the lazy conversation hydrate
 * (fetch-conversation.ts, for ids the roster does not carry) normalizes through
 * the SAME explicit whitelist the WS path does. Two mappers would drift, and
 * this whitelist has already lost fields silently twice -- see the liveStatus
 * and transport notes below.
 */

import type { ConversationSummary } from '@shared/protocol'
import type { Conversation } from '@/lib/types'

/** Task-roster fields with their empty-state fallbacks, lifted out of
 *  toConversation to keep that mapper under the complexity bar. */
function toTaskFields(summary: ConversationSummary) {
  return {
    taskCount: summary.taskCount ?? 0,
    pendingTaskCount: summary.pendingTaskCount ?? 0,
    activeTasks: summary.activeTasks ?? [],
    pendingTasks: summary.pendingTasks ?? [],
    completedTaskCount: summary.completedTaskCount ?? 0,
    completedTasks: summary.completedTasks ?? [],
    archivedTaskCount: summary.archivedTaskCount ?? 0,
    archivedTasks: summary.archivedTasks ?? [],
  }
}

export function toConversation(summary: ConversationSummary): Conversation {
  return {
    id: summary.id,
    project: summary.project,
    model: summary.model,
    capabilities: summary.capabilities,
    connectionIds: summary.connectionIds,
    startedAt: summary.startedAt,
    lastActivity: summary.lastActivity,
    status: summary.status,
    compacting: summary.compacting,
    compactedAt: summary.compactedAt,
    eventCount: summary.eventCount,
    activeSubagentCount: summary.activeSubagentCount ?? 0,
    totalSubagentCount: summary.totalSubagentCount ?? 0,
    subagents: summary.subagents ?? [],
    ...toTaskFields(summary),
    runningBgTaskCount: summary.runningBgTaskCount ?? 0,
    bgTasks: summary.bgTasks ?? [],
    monitors: summary.monitors ?? [],
    runningMonitorCount: summary.runningMonitorCount ?? 0,
    teammates: summary.teammates ?? [],
    team: summary.team,
    effortLevel: summary.effortLevel,
    permissionMode: summary.permissionMode,
    lastError: summary.lastError,
    rateLimit: summary.rateLimit,
    planMode: summary.planMode,
    pendingAttention: summary.pendingAttention,
    // THE STATUS: the agent's self-reported set_status slot drives the per-
    // conversation attention badge (StatusBadge). Easy to miss in this explicit
    // whitelist -- omitting it silently drops the field client-side so the card
    // badge never renders even though the broker serializes + broadcasts it.
    liveStatus: summary.liveStatus,
    lastInputAt: summary.lastInputAt,
    pendingSpawnApproval: summary.pendingSpawnApproval,
    spawnAutoApproved: summary.spawnAutoApproved,
    hasNotification: summary.hasNotification,
    summary: summary.summary,
    title: summary.title,
    description: summary.description,
    agentName: summary.agentName,
    prLinks: summary.prLinks,
    linkedProjects: summary.linkedProjects,
    linkedConversations: summary.linkedConversations,
    tokenUsage: summary.tokenUsage,
    contextWindow: summary.contextWindow,
    cacheTtl: summary.cacheTtl,
    lastTurnEndedAt: summary.lastTurnEndedAt,
    stats: summary.stats,
    costTimeline: summary.costTimeline,
    gitBranch: summary.gitBranch,
    adHocTaskId: summary.adHocTaskId,
    adHocWorktree: summary.adHocWorktree,
    resultText: summary.resultText,
    recap: summary.recap,
    recapFresh: summary.recapFresh,
    hostSentinelId: summary.hostSentinelId,
    hostSentinelAlias: summary.hostSentinelAlias,
    shellCapable: summary.shellCapable,
    resolvedProfile: summary.resolvedProfile,
    version: summary.version,
    buildTime: summary.buildTime,
    claudeVersion: summary.claudeVersion,
    claudeAuth: summary.claudeAuth,
    spinnerVerbs: summary.spinnerVerbs,
    autocompactPct: summary.autocompactPct,
    backend: summary.backend,
    // Resolved transport ('claude-pty' | 'claude-headless' | 'claude-daemon').
    // Serialized by the broker (conversation-store toConversationSummary) but was
    // dropped from this whitelist -- so transport was always undefined client-side
    // (the silent-drop bug the liveStatus note above warns about). The Login
    // palette command + any transport-gated UI need it.
    transport: summary.transport,
    // Spawn lineage (Phase 3 carries parent/root over WS; directChildCount is
    // REST-only, so it stays undefined here and the UI walks the local list).
    parentConversationId: summary.parentConversationId,
    rootConversationId: summary.rootConversationId,
    // Night-task origin tag (drives the live Status screen's per-task rows).
    nightshift: summary.nightshift,
  }
}
