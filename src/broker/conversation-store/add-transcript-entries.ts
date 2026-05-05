import type {
  Conversation,
  TranscriptAgentNameEntry,
  TranscriptAssistantEntry,
  TranscriptCustomTitleEntry,
  TranscriptEntry,
  TranscriptPrLinkEntry,
  TranscriptSummaryEntry,
  TranscriptSystemEntry,
  TranscriptUserEntry,
} from '../../shared/protocol'
import { MAX_TRANSCRIPT_ENTRIES } from './constants'
import { assignTranscriptSeqs, type ConversationStoreContext } from './event-context'
import { handleAssistantEntry } from './transcript-handlers/assistant-entry'
import { detectBgTaskNotifications } from './transcript-handlers/bg-task-notifications'
import {
  handleAgentNameEntry,
  handleCustomTitleEntry,
  handlePrLinkEntry,
  handleSummaryEntry,
} from './transcript-handlers/metadata-entry'
import { extractLiveSubagentEntries } from './transcript-handlers/subagent-extraction'
import { handleSystemEntry } from './transcript-handlers/system-entry'
import { handleUserEntry } from './transcript-handlers/user-entry'

/**
 * Persist a batch of transcript entries to the cache + derive conversation-level
 * stats / metadata from them. Re-broadcasts compaction markers and live
 * subagent transcripts. No-op when the conversation isn't registered.
 *
 * Thin orchestrator: cache + seq stamping + dirty flag + stats reset live
 * here, plus post-loop scans for bg-task notifications and live subagent
 * transcripts. Per-entry-type work delegates to typed helpers under
 * `transcript-handlers/`, dispatched through the `entryHandlers` table
 * below. Each helper returns `boolean` indicating whether conversation metadata
 * changed so the orchestrator can decide if a conversation update is warranted.
 */
export function addTranscriptEntries(
  ctx: ConversationStoreContext,
  conversationId: string,
  entries: TranscriptEntry[],
  isInitial: boolean,
): void {
  // Stamp seqs BEFORE cache insert and BEFORE any broadcast the caller does.
  // All entries in `entries` are mutated in place with `entry.seq = N`.
  // Callers (handlers/transcript.ts, handlers/boot-lifecycle.ts) then
  // broadcast the same objects, so the wire payload carries seqs too.
  assignTranscriptSeqs(ctx.transcriptSeqCounters, conversationId, entries, isInitial)
  appendToCache(ctx, conversationId, entries, isInitial)
  ctx.dirtyTranscripts.add(conversationId)

  const conv = ctx.conversations.get(conversationId)
  if (!conv) return

  if (!conv.stats || isInitial) resetSessionMetadataAndStats(conv, isInitial)

  let sessionChanged = false
  for (const entry of entries) {
    // gitBranch lives on the base type and applies to any entry
    if (!conv.gitBranch && entry.gitBranch) {
      conv.gitBranch = entry.gitBranch
      sessionChanged = true
    }

    if (entryHandlers[entry.type]?.(ctx, conversationId, conv, entry, isInitial)) {
      sessionChanged = true
    }
  }

  // Post-loop scans: bg task completion + live subagent extraction
  if (detectBgTaskNotifications(conv, entries)) sessionChanged = true
  extractLiveSubagentEntries(ctx, conversationId, entries)

  if (sessionChanged) ctx.scheduleConversationUpdate(conversationId)
}

// ─── per-entry-type dispatch table ─────────────────────────────────────────
//
// Each entry adapts a typed transcript-handler helper to the uniform
// `TranscriptEntryHandler` signature so the orchestrator can dispatch
// through a `Record<entryType, TranscriptEntryHandler>`. The narrow cast
// happens once at the boundary in each adapter; the helpers themselves
// work with the narrow type. Each adapter returns `true` when conversation
// metadata mutated, so the orchestrator can OR the results and decide
// whether to schedule a conversation update.

type TranscriptEntryHandler = (
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  isInitial: boolean,
) => boolean

function dispatchCompacted(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  conv: Conversation,
  _entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  conv.stats.compactionCount++
  return false
}

function dispatchUserEntry(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  isInitial: boolean,
): boolean {
  return handleUserEntry(ctx, conversationId, conv, entry as TranscriptUserEntry, isInitial)
}

function dispatchAssistantEntry(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  return handleAssistantEntry(conv, entry as TranscriptAssistantEntry)
}

function dispatchSystemEntry(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  isInitial: boolean,
): boolean {
  return handleSystemEntry(ctx, conversationId, conv, entry as TranscriptSystemEntry, isInitial)
}

function dispatchSummaryEntry(
  _ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  return handleSummaryEntry(conversationId, conv, entry as TranscriptSummaryEntry)
}

function dispatchCustomTitleEntry(
  _ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  return handleCustomTitleEntry(conversationId, conv, entry as TranscriptCustomTitleEntry)
}

function dispatchAgentNameEntry(
  _ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  return handleAgentNameEntry(conversationId, conv, entry as TranscriptAgentNameEntry)
}

function dispatchPrLinkEntry(
  _ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  return handlePrLinkEntry(conversationId, conv, entry as TranscriptPrLinkEntry)
}

const entryHandlers: Record<string, TranscriptEntryHandler> = {
  compacted: dispatchCompacted,
  user: dispatchUserEntry,
  assistant: dispatchAssistantEntry,
  system: dispatchSystemEntry,
  summary: dispatchSummaryEntry,
  'custom-title': dispatchCustomTitleEntry,
  'agent-name': dispatchAgentNameEntry,
  'pr-link': dispatchPrLinkEntry,
}

function appendToCache(
  ctx: ConversationStoreContext,
  conversationId: string,
  entries: TranscriptEntry[],
  isInitial: boolean,
): void {
  if (isInitial) {
    ctx.transcriptCache.set(conversationId, entries.slice(-MAX_TRANSCRIPT_ENTRIES))
    return
  }
  const existing = ctx.transcriptCache.get(conversationId) || []
  existing.push(...entries)
  if (existing.length > MAX_TRANSCRIPT_ENTRIES) {
    ctx.transcriptCache.set(conversationId, existing.slice(-MAX_TRANSCRIPT_ENTRIES))
  } else {
    ctx.transcriptCache.set(conversationId, existing)
  }
}

function resetSessionMetadataAndStats(
  conv: NonNullable<ReturnType<ConversationStoreContext['conversations']['get']>>,
  isInitial: boolean,
): void {
  // Reset metadata + stats on initial load to avoid double-counting when
  // the transcript watcher re-reads the full file (restart, reconnect,
  // truncation recovery). Preserve user-set titles (set via spawn dialog).
  if (isInitial) {
    conv.summary = undefined
    if (!conv.titleUserSet) conv.title = undefined
    conv.agentName = undefined
    conv.prLinks = undefined
  }
  conv.stats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreation: 0,
    totalCacheWrite5m: 0,
    totalCacheWrite1h: 0,
    totalCacheRead: 0,
    turnCount: 0,
    toolCallCount: 0,
    compactionCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
    totalApiDurationMs: 0,
  }
}
